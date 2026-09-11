/*
 * Slideshow: crossfades between two stacked <img> layers. The next image
 * is always preloaded and decode()'d ahead of time so the fade never
 * starts on an undecoded image (which shows as a white flash on iOS).
 */
var Slideshow = (function () {
  var layerA, layerB;
  var activeLayer; // element currently visible
  var order = []; // array of photo ids in play order
  var pos = 0; // index into order for the currently-shown photo
  var timerId = null;
  var intervalMs = 30000;
  var pending = null; // { id, objectURL, img } preloaded next photo
  var running = false;
  var shuffleEnabled = false;
  var wakeLockSentinel = null;
  var onExit = null;

  var FADE_MS = 1200;

  function init() {
    layerA = document.getElementById('slide-a');
    layerB = document.getElementById('slide-b');
  }

  function shuffleArray(arr) {
    return shuffleRange(arr, 0);
  }

  // Fisher-Yates over arr[start..end], leaving indices before start untouched.
  function shuffleRange(arr, start) {
    for (var i = arr.length - 1; i > start; i--) {
      var j = start + Math.floor(Math.random() * (i - start + 1));
      var tmp = arr[i];
      arr[i] = arr[j];
      arr[j] = tmp;
    }
    return arr;
  }

  function loadPhoto(id) {
    return PhotoDB.getPhoto(id).then(function (record) {
      if (!record) {
        return null;
      }
      var objectURL = PhotoDB.recordToObjectURL(record);
      var img = new Image();
      img.src = objectURL;
      var decodePromise;
      if (typeof img.decode === 'function') {
        decodePromise = img.decode().catch(function () {
          // decode() can reject on some WebKit versions even though the
          // image is actually fine; fall back to load event.
          return waitForLoad(img);
        });
      } else {
        decodePromise = waitForLoad(img);
      }
      return decodePromise.then(function () {
        return { id: id, objectURL: objectURL, img: img };
      });
    });
  }

  function waitForLoad(img) {
    return new Promise(function (resolve) {
      if (img.complete) {
        resolve();
        return;
      }
      img.onload = function () {
        resolve();
      };
      img.onerror = function () {
        resolve();
      };
    });
  }

  function preloadNext() {
    var nextPos = (pos + 1) % order.length;
    var nextId = order[nextPos];
    loadPhoto(nextId).then(function (loaded) {
      if (running && loaded) {
        pending = loaded;
      }
    });
  }

  function requestWakeLock() {
    if (navigator.wakeLock && typeof navigator.wakeLock.request === 'function') {
      navigator.wakeLock.request('screen').then(function (sentinel) {
        wakeLockSentinel = sentinel;
        sentinel.addEventListener('release', function () {
          wakeLockSentinel = null;
        });
      }).catch(function () {
        // Wake lock unavailable/denied; slideshow still works, screen
        // may just dim per normal iOS behavior.
        wakeLockSentinel = null;
      });
    }
  }

  function releaseWakeLock() {
    if (wakeLockSentinel) {
      wakeLockSentinel.release().catch(function () {});
      wakeLockSentinel = null;
    }
  }

  function showFirst(loaded) {
    activeLayer = layerA;
    activeLayer.src = loaded.objectURL;
    activeLayer._objectURL = loaded.objectURL;
    // Force reflow so the transition applies on the subsequent class add.
    void activeLayer.offsetWidth;
    activeLayer.classList.add('active');
  }

  function advance() {
    if (!running || order.length === 0) {
      return;
    }

    var nextPos = (pos + 1) % order.length;
    var nextId = order[nextPos];

    // Completed a full lap: reshuffle everything after this photo so the
    // next lap isn't an exact repeat of the same order. Index nextPos
    // (about to be shown) is left untouched, so there's no risk of it
    // getting shuffled into an immediate repeat of itself.
    if (nextPos === 0 && shuffleEnabled && order.length > 1) {
      shuffleRange(order, 1);
    }

    var readyPromise;
    if (pending && pending.id === nextId) {
      readyPromise = Promise.resolve(pending);
      pending = null;
    } else {
      readyPromise = loadPhoto(nextId);
    }

    readyPromise.then(function (loaded) {
      if (!running || !loaded) {
        return;
      }

      var incomingLayer = activeLayer === layerA ? layerB : layerA;
      var outgoingLayer = activeLayer;

      incomingLayer.src = loaded.objectURL;
      incomingLayer._objectURL = loaded.objectURL;
      void incomingLayer.offsetWidth;

      incomingLayer.classList.add('active');
      outgoingLayer.classList.remove('active');

      activeLayer = incomingLayer;
      pos = nextPos;

      var staleURL = outgoingLayer._objectURL;
      outgoingLayer._objectURL = null;
      setTimeout(function () {
        if (staleURL) {
          URL.revokeObjectURL(staleURL);
        }
      }, FADE_MS + 200);

      if (order.length > 1) {
        preloadNext();
      }
    });
  }

  function scheduleTimer() {
    clearTimer();
    if (order.length > 1) {
      timerId = setTimeout(function () {
        advance();
        scheduleTimer();
      }, intervalMs);
    }
  }

  function clearTimer() {
    if (timerId) {
      clearTimeout(timerId);
      timerId = null;
    }
  }

  // Advances immediately (e.g. on a tap) and restarts the interval timer
  // from now, so the auto-advance doesn't fire again right on its heels.
  function advanceNow() {
    if (!running || order.length <= 1) {
      return;
    }
    advance();
    scheduleTimer();
  }

  // opts: { photoIds, interval, shuffle, onExit }
  function start(opts) {
    if (!layerA) {
      init();
    }

    order = opts.photoIds.slice();
    shuffleEnabled = !!opts.shuffle;
    if (shuffleEnabled) {
      shuffleArray(order);
    }
    intervalMs = opts.interval;
    onExit = opts.onExit || null;
    pos = 0;
    pending = null;
    running = true;

    layerA.classList.remove('active');
    layerB.classList.remove('active');
    layerA.removeAttribute('src');
    layerB.removeAttribute('src');

    requestWakeLock();

    var firstId = order[0];
    loadPhoto(firstId).then(function (loaded) {
      if (!running || !loaded) {
        return;
      }
      showFirst(loaded);
      if (order.length > 1) {
        preloadNext();
      }
      scheduleTimer();
    });
  }

  function stop() {
    running = false;
    clearTimer();
    releaseWakeLock();

    [layerA, layerB].forEach(function (layer) {
      if (!layer) {
        return;
      }
      layer.classList.remove('active');
      if (layer._objectURL) {
        URL.revokeObjectURL(layer._objectURL);
        layer._objectURL = null;
      }
      layer.removeAttribute('src');
    });

    if (pending && pending.objectURL) {
      URL.revokeObjectURL(pending.objectURL);
      pending = null;
    }

    order = [];
    pos = 0;
  }

  function exit() {
    if (!running) {
      return;
    }
    var cb = onExit;
    stop();
    if (cb) {
      cb();
    }
  }

  // Wake locks are auto-released whenever the document goes hidden (screen
  // lock, app switch). Re-acquire it if we come back to the foreground
  // still mid-slideshow, to minimize the chance of the screen — and
  // eventually the whole page — getting suspended by iOS.
  document.addEventListener('visibilitychange', function () {
    if (running && document.visibilityState === 'visible' && !wakeLockSentinel) {
      requestWakeLock();
    }
  });

  return {
    init: init,
    start: start,
    stop: stop,
    advanceNow: advanceNow,
    exit: exit
  };
})();

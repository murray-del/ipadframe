/*
 * Settings screen: import pipeline, thumbnail grid, quota display,
 * and wiring between the settings and slideshow screens.
 */
(function () {
  var MAX_DIMENSION = 2048;
  var JPEG_QUALITY = 0.8;
  var SETTINGS_KEY = 'photoframe-settings';

  var settingsScreen, slideshowScreen;
  var addPhotosBtn, fileInput, quotaInfo, importProgress;
  var thumbGrid, emptyMsg;
  var intervalSelect, shuffleToggle, startBtn;

  var photoMeta = []; // cached metadata list, most-recent first

  function loadSettings() {
    var defaults = { interval: 30000, shuffle: false };
    try {
      var raw = localStorage.getItem(SETTINGS_KEY);
      if (!raw) {
        return defaults;
      }
      var parsed = JSON.parse(raw);
      return {
        interval: parsed.interval || defaults.interval,
        shuffle: !!parsed.shuffle
      };
    } catch (e) {
      return defaults;
    }
  }

  function saveSettings() {
    var settings = {
      interval: parseInt(intervalSelect.value, 10),
      shuffle: shuffleToggle.checked
    };
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    } catch (e) {
      // localStorage unavailable (private mode edge cases); ignore.
    }
  }

  // ---------- Quota ----------

  function formatBytes(bytes) {
    if (bytes < 1024) {
      return bytes + ' B';
    }
    var units = ['KB', 'MB', 'GB'];
    var value = bytes;
    var unitIndex = -1;
    do {
      value = value / 1024;
      unitIndex++;
    } while (value >= 1024 && unitIndex < units.length - 1);
    return value.toFixed(1) + ' ' + units[unitIndex];
  }

  function refreshQuota() {
    if (!navigator.storage || typeof navigator.storage.estimate !== 'function') {
      quotaInfo.textContent = '';
      return;
    }
    navigator.storage.estimate().then(function (estimate) {
      var usage = estimate.usage || 0;
      var quota = estimate.quota || 0;
      if (quota > 0) {
        var remaining = Math.max(quota - usage, 0);
        quotaInfo.textContent = formatBytes(remaining) + ' free of ' + formatBytes(quota);
      }
    }).catch(function () {
      quotaInfo.textContent = '';
    });
  }

  function requestPersistence() {
    if (navigator.storage && typeof navigator.storage.persist === 'function') {
      navigator.storage.persist().catch(function () {});
    }
  }

  // ---------- Import pipeline ----------

  // Loads a File into an <img> via a temporary object URL.
  function loadImageFromFile(file) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () {
        resolve({ img: img, url: url });
      };
      img.onerror = function () {
        URL.revokeObjectURL(url);
        reject(new Error('Could not load image'));
      };
      img.src = url;
    });
  }

  // Downscales to MAX_DIMENSION on the long edge and re-encodes as JPEG.
  function downscaleToJpegBlob(img) {
    var width = img.naturalWidth || img.width;
    var height = img.naturalHeight || img.height;
    var scale = Math.min(1, MAX_DIMENSION / Math.max(width, height));
    var targetWidth = Math.max(1, Math.round(width * scale));
    var targetHeight = Math.max(1, Math.round(height * scale));

    var canvas = document.createElement('canvas');
    canvas.width = targetWidth;
    canvas.height = targetHeight;
    var ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0, targetWidth, targetHeight);

    return new Promise(function (resolve, reject) {
      canvas.toBlob(function (blob) {
        if (blob) {
          resolve({ blob: blob, width: targetWidth, height: targetHeight });
        } else {
          reject(new Error('Canvas encoding failed'));
        }
      }, 'image/jpeg', JPEG_QUALITY);
    });
  }

  function blobToArrayBuffer(blob) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () {
        resolve(reader.result);
      };
      reader.onerror = function () {
        reject(reader.error);
      };
      reader.readAsArrayBuffer(blob);
    });
  }

  function importFile(file) {
    var loadedImg, loadedUrl;
    return loadImageFromFile(file).then(function (loaded) {
      loadedImg = loaded.img;
      loadedUrl = loaded.url;
      return downscaleToJpegBlob(loadedImg);
    }).then(function (result) {
      URL.revokeObjectURL(loadedUrl);
      return blobToArrayBuffer(result.blob).then(function (buffer) {
        return PhotoDB.addPhoto({
          name: file.name,
          mimeType: 'image/jpeg',
          width: result.width,
          height: result.height,
          data: buffer
        });
      });
    }).catch(function (err) {
      if (loadedUrl) {
        URL.revokeObjectURL(loadedUrl);
      }
      console.error('Failed to import', file.name, err);
      return null;
    });
  }

  function importFiles(files) {
    var total = files.length;
    var done = 0;
    importProgress.hidden = false;
    importProgress.textContent = 'Importing 0 / ' + total + '…';

    var chain = Promise.resolve();
    files.forEach(function (file) {
      chain = chain.then(function () {
        return importFile(file).then(function () {
          done++;
          importProgress.textContent = 'Importing ' + done + ' / ' + total + '…';
        });
      });
    });

    return chain.then(function () {
      importProgress.hidden = true;
      return refreshGrid();
    });
  }

  // ---------- Thumbnail grid ----------

  function refreshGrid() {
    return PhotoDB.getAllMeta().then(function (list) {
      list.sort(function (a, b) {
        return b.createdAt - a.createdAt;
      });
      photoMeta = list;
      renderGrid();
      refreshQuota();
    });
  }

  function renderGrid() {
    thumbGrid.innerHTML = '';
    emptyMsg.classList.toggle('hidden', photoMeta.length > 0);
    startBtn.disabled = photoMeta.length === 0;

    photoMeta.forEach(function (meta) {
      var cell = document.createElement('div');
      cell.className = 'thumb';

      var img = document.createElement('img');
      cell.appendChild(img);

      var del = document.createElement('button');
      del.type = 'button';
      del.className = 'thumb-delete';
      del.textContent = '×';
      del.setAttribute('aria-label', 'Delete photo');
      del.addEventListener('click', function () {
        handleDelete(meta.id, cell, img);
      });
      cell.appendChild(del);

      thumbGrid.appendChild(cell);

      PhotoDB.getPhoto(meta.id).then(function (record) {
        if (!record) {
          return;
        }
        var url = PhotoDB.recordToObjectURL(record);
        img._objectURL = url;
        img.onload = function () {
          URL.revokeObjectURL(url);
        };
        img.src = url;
      });
    });
  }

  function handleDelete(id, cell, img) {
    PhotoDB.deletePhoto(id).then(function () {
      if (img && img._objectURL) {
        URL.revokeObjectURL(img._objectURL);
      }
      if (cell && cell.parentNode) {
        cell.parentNode.removeChild(cell);
      }
      photoMeta = photoMeta.filter(function (m) {
        return m.id !== id;
      });
      emptyMsg.classList.toggle('hidden', photoMeta.length > 0);
      startBtn.disabled = photoMeta.length === 0;
      refreshQuota();
    });
  }

  // ---------- Fullscreen (hides the iOS status bar on iPadOS 16.4+) ----------

  function requestFullscreenIfSupported() {
    var el = document.documentElement;
    var request = el.requestFullscreen || el.webkitRequestFullscreen;
    if (typeof request === 'function') {
      try {
        var result = request.call(el);
        if (result && typeof result.catch === 'function') {
          result.catch(function () {});
        }
      } catch (e) {
        // Fullscreen API unsupported or blocked; the app still works,
        // just with the translucent status bar showing.
      }
    }
  }

  function exitFullscreenIfActive() {
    var isFullscreen = document.fullscreenElement || document.webkitFullscreenElement;
    if (!isFullscreen) {
      return;
    }
    var exit = document.exitFullscreen || document.webkitExitFullscreen;
    if (typeof exit === 'function') {
      try {
        var result = exit.call(document);
        if (result && typeof result.catch === 'function') {
          result.catch(function () {});
        }
      } catch (e) {}
    }
  }

  function handleFullscreenChange() {
    // Covers the case where the user exits fullscreen via a system
    // gesture (e.g. swiping up) instead of tapping the slideshow.
    var isFullscreen = document.fullscreenElement || document.webkitFullscreenElement;
    if (!isFullscreen) {
      Slideshow.handleTap();
    }
  }

  // ---------- Screen switching ----------

  function showSettings() {
    slideshowScreen.classList.add('hidden');
    settingsScreen.classList.remove('hidden');
    refreshQuota();
  }

  function showSlideshow() {
    settingsScreen.classList.add('hidden');
    slideshowScreen.classList.remove('hidden');
  }

  function handleStart() {
    if (photoMeta.length === 0) {
      return;
    }
    // Must be called synchronously within the click handler to count
    // as a user gesture.
    requestFullscreenIfSupported();
    var settings = loadSettings();
    var photoIds = photoMeta.map(function (m) {
      return m.id;
    });
    showSlideshow();
    Slideshow.start({
      photoIds: photoIds,
      interval: settings.interval,
      shuffle: settings.shuffle,
      onExit: showSettings
    });
  }

  // ---------- Wiring ----------

  function bindEvents() {
    addPhotosBtn.addEventListener('click', function () {
      fileInput.click();
    });

    fileInput.addEventListener('change', function () {
      var files = Array.prototype.slice.call(fileInput.files || []);
      fileInput.value = '';
      if (files.length > 0) {
        importFiles(files);
      }
    });

    intervalSelect.addEventListener('change', saveSettings);
    shuffleToggle.addEventListener('change', saveSettings);

    startBtn.addEventListener('click', handleStart);

    slideshowScreen.addEventListener('click', function () {
      exitFullscreenIfActive();
      Slideshow.handleTap();
    });

    document.addEventListener('fullscreenchange', handleFullscreenChange);
    document.addEventListener('webkitfullscreenchange', handleFullscreenChange);
  }

  function applySavedSettings() {
    var settings = loadSettings();
    intervalSelect.value = String(settings.interval);
    shuffleToggle.checked = settings.shuffle;
  }

  function registerServiceWorker() {
    if ('serviceWorker' in navigator) {
      window.addEventListener('load', function () {
        navigator.serviceWorker.register('./sw.js').catch(function (err) {
          console.error('Service worker registration failed', err);
        });
      });
    }
  }

  function init() {
    settingsScreen = document.getElementById('settings-screen');
    slideshowScreen = document.getElementById('slideshow-screen');
    addPhotosBtn = document.getElementById('add-photos-btn');
    fileInput = document.getElementById('file-input');
    quotaInfo = document.getElementById('quota-info');
    importProgress = document.getElementById('import-progress');
    thumbGrid = document.getElementById('thumb-grid');
    emptyMsg = document.getElementById('empty-msg');
    intervalSelect = document.getElementById('interval-select');
    shuffleToggle = document.getElementById('shuffle-toggle');
    startBtn = document.getElementById('start-btn');

    Slideshow.init();
    applySavedSettings();
    bindEvents();
    refreshGrid();
    requestPersistence();
    registerServiceWorker();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();

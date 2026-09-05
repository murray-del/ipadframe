/*
 * Caches the app shell so the frame launches with no network connection.
 * Bump CACHE_VERSION whenever a shell file changes; activate cleans up
 * any caches from older versions.
 */
var CACHE_VERSION = 'v2';
var CACHE_NAME = 'photoframe-shell-' + CACHE_VERSION;

var SHELL_FILES = [
  './',
  './index.html',
  './css/style.css',
  './js/db.js',
  './js/slideshow.js',
  './js/app.js',
  './manifest.json',
  './icons/icon-180.png',
  './icons/icon-512.png'
];

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE_NAME).then(function (cache) {
      return cache.addAll(SHELL_FILES);
    }).then(function () {
      return self.skipWaiting();
    })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (names) {
      return Promise.all(
        names.filter(function (name) {
          return name.indexOf('photoframe-shell-') === 0 && name !== CACHE_NAME;
        }).map(function (name) {
          return caches.delete(name);
        })
      );
    }).then(function () {
      return self.clients.claim();
    })
  );
});

self.addEventListener('fetch', function (event) {
  var request = event.request;

  if (request.method !== 'GET') {
    return;
  }

  // Only handle same-origin requests; let everything else (if any) pass through.
  var url = new URL(request.url);
  if (url.origin !== self.location.origin) {
    return;
  }

  event.respondWith(
    caches.match(request).then(function (cached) {
      if (cached) {
        return cached;
      }
      return fetch(request).then(function (response) {
        if (response && response.ok) {
          var responseClone = response.clone();
          caches.open(CACHE_NAME).then(function (cache) {
            cache.put(request, responseClone);
          });
        }
        return response;
      }).catch(function () {
        if (request.mode === 'navigate') {
          return caches.match('./index.html');
        }
        return undefined;
      });
    })
  );
});

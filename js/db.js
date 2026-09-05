/*
 * IndexedDB wrapper. Images are stored as ArrayBuffer, not Blob:
 * WebKit has known bugs storing/retrieving Blobs in IndexedDB, so we
 * always store raw ArrayBuffer + mimeType and reconstruct a Blob on read.
 */
var PhotoDB = (function () {
  var DB_NAME = 'photoframe-db';
  var DB_VERSION = 1;
  var STORE_NAME = 'photos';

  var dbPromise = null;

  function openDB() {
    if (dbPromise) {
      return dbPromise;
    }
    dbPromise = new Promise(function (resolve, reject) {
      var req = indexedDB.open(DB_NAME, DB_VERSION);

      req.onupgradeneeded = function (event) {
        var db = event.target.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          var store = db.createObjectStore(STORE_NAME, { keyPath: 'id', autoIncrement: true });
          store.createIndex('createdAt', 'createdAt', { unique: false });
        }
      };

      req.onsuccess = function (event) {
        resolve(event.target.result);
      };

      req.onerror = function (event) {
        reject(event.target.error);
      };
    });
    return dbPromise;
  }

  function addPhoto(record) {
    return openDB().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(STORE_NAME, 'readwrite');
        var store = tx.objectStore(STORE_NAME);
        record.createdAt = Date.now();
        var req = store.add(record);
        req.onsuccess = function (event) {
          resolve(event.target.result);
        };
        req.onerror = function (event) {
          reject(event.target.error);
        };
      });
    });
  }

  // Returns lightweight metadata for every photo (id, name, createdAt, width, height)
  // without pulling the full ArrayBuffer into memory.
  function getAllMeta() {
    return openDB().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(STORE_NAME, 'readonly');
        var store = tx.objectStore(STORE_NAME);
        var index = store.index('createdAt');
        var results = [];
        var req = index.openCursor();
        req.onsuccess = function (event) {
          var cursor = event.target.result;
          if (cursor) {
            var value = cursor.value;
            results.push({
              id: value.id,
              name: value.name,
              mimeType: value.mimeType,
              width: value.width,
              height: value.height,
              createdAt: value.createdAt
            });
            cursor.continue();
          } else {
            resolve(results);
          }
        };
        req.onerror = function (event) {
          reject(event.target.error);
        };
      });
    });
  }

  // Fetches the full record (including ArrayBuffer) for a single photo.
  function getPhoto(id) {
    return openDB().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(STORE_NAME, 'readonly');
        var store = tx.objectStore(STORE_NAME);
        var req = store.get(id);
        req.onsuccess = function (event) {
          resolve(event.target.result || null);
        };
        req.onerror = function (event) {
          reject(event.target.error);
        };
      });
    });
  }

  function deletePhoto(id) {
    return openDB().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(STORE_NAME, 'readwrite');
        var store = tx.objectStore(STORE_NAME);
        var req = store.delete(id);
        req.onsuccess = function () {
          resolve();
        };
        req.onerror = function (event) {
          reject(event.target.error);
        };
      });
    });
  }

  // Reconstructs a Blob from a stored record's ArrayBuffer and returns
  // an object URL for it. Caller is responsible for revoking the URL.
  function recordToObjectURL(record) {
    var blob = new Blob([record.data], { type: record.mimeType });
    return URL.createObjectURL(blob);
  }

  return {
    addPhoto: addPhoto,
    getAllMeta: getAllMeta,
    getPhoto: getPhoto,
    deletePhoto: deletePhoto,
    recordToObjectURL: recordToObjectURL
  };
})();

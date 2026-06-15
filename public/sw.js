const CACHE_NAME = "tankwars-v2";
const ASSETS = ["/", "/index.html", "/favicon.svg", "/manifest.json"];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => {
        return cache.addAll(ASSETS);
      })
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => {
        return Promise.all(
          keys.map((key) => {
            if (key !== CACHE_NAME) {
              return caches.delete(key);
            }
          })
        );
      })
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  // Ignorer les requêtes cross-origin pour éviter les violations de CSP au sein du Service Worker
  if (!e.request.url.startsWith(self.location.origin)) {
    return;
  }

  // Stratégie Network-First pour les requêtes de navigation (index.html)
  // afin de toujours charger la version la plus récente contenant les bons bundles JS
  if (e.request.mode === "navigate") {
    e.respondWith(
      fetch(e.request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(e.request, copy));
          }
          return response;
        })
        .catch(() => {
          return caches.match(e.request).then((cachedResponse) => {
            if (cachedResponse) {
              return cachedResponse;
            }
            return caches.match("/index.html");
          });
        })
    );
    return;
  }

  // Stratégie Cache-First pour les autres ressources locales
  e.respondWith(
    caches.match(e.request).then((cachedResponse) => {
      if (cachedResponse) {
        return cachedResponse;
      }
      return fetch(e.request).catch((err) => {
        // Propager l'erreur réseau au lieu de renvoyer undefined
        throw err;
      });
    })
  );
});


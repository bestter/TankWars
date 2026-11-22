const CACHE_NAME = "tankwars-v4";
const ASSETS = [
  "/",
  "/index.html",
  "/favicon.svg",
  "/favicon-32.png",
  "/apple-touch-icon.png",
  "/icon-512.png",
  "/manifest.json",
];

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

  const requestUrl = new URL(e.request.url);
  const isManifestRequest =
    requestUrl.pathname === "/manifest.json" ||
    e.request.destination === "manifest";

  // Stratégie Network-First pour les requêtes de navigation (index.html) et le manifeste PWA
  // afin de toujours charger la version la plus récente tout en préservant le mode hors ligne
  if (e.request.mode === "navigate" || isManifestRequest) {
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
          return caches
            .match(e.request, { cacheName: CACHE_NAME })
            .then((cachedResponse) => {
              if (cachedResponse) {
                return cachedResponse;
              }
              if (e.request.mode === "navigate") {
                return caches.match("/index.html", { cacheName: CACHE_NAME });
              }
              return caches.match("/manifest.json", { cacheName: CACHE_NAME });
            });
        })
    );
    return;
  }

  // Stratégie Cache-First pour les autres ressources locales
  e.respondWith(
    caches
      .match(e.request, { cacheName: CACHE_NAME })
      .then((cachedResponse) => {
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


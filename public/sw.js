const CACHE_NAME = "tankwars-v4";
const MANIFEST_PATH = "/manifest.json";
// Un manifeste encore frais dans le cache HTTP peut appartenir à l'ancienne version.
const MANIFEST_FETCH_OPTIONS = { cache: "reload" };
const ASSETS = [
  "/",
  "/index.html",
  "/favicon.svg",
  "/favicon-32.png",
  "/apple-touch-icon.png",
  "/icon-512.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => {
        const manifest = new Request(
          new URL(MANIFEST_PATH, self.location.origin),
          MANIFEST_FETCH_OPTIONS
        );
        return cache.addAll([...ASSETS, manifest]);
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
  if (e.request.method && e.request.method !== "GET") {
    return;
  }

  let requestUrl;
  try {
    requestUrl = new URL(e.request.url);
  } catch {
    return;
  }

  // Ignorer les requêtes cross-origin pour éviter les violations de CSP au sein du Service Worker
  if (requestUrl.origin !== self.location.origin) {
    return;
  }

  const isManifestRequest =
    requestUrl.pathname === MANIFEST_PATH ||
    e.request.destination === "manifest";
  const isNavigate = e.request.mode === "navigate";

  // Stratégie Network-First pour les requêtes de navigation (index.html) et le manifeste PWA
  // afin de toujours charger la version la plus récente tout en préservant le mode hors ligne
  if (e.request.mode === "navigate" || isManifestRequest) {
    const fetchRequest =
      isManifestRequest && !isNavigate
        ? fetch(e.request, MANIFEST_FETCH_OPTIONS)
        : fetch(e.request);

    e.respondWith(
      fetchRequest
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            const cacheWrite = caches
              .open(CACHE_NAME)
              .then((cache) => cache.put(e.request, copy))
              .catch((err) => {
                if (typeof console !== "undefined") {
                  console.warn("[sw] Cache update failed", err);
                }
              });
            if (typeof e.waitUntil === "function") {
              e.waitUntil(cacheWrite);
            }
          }
          return response;
        })
        .catch((err) => {
          return caches
            .match(e.request, { cacheName: CACHE_NAME })
            .then((cachedResponse) => {
              if (cachedResponse) {
                return cachedResponse;
              }
              if (isManifestRequest) {
                return caches.match(MANIFEST_PATH, { cacheName: CACHE_NAME });
              }
              return caches.match("/index.html", { cacheName: CACHE_NAME });
            })
            .then((fallback) => {
              if (fallback) {
                return fallback;
              }
              throw err;
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


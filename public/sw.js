const CACHE_NAME = "tankwars-v6";
const APP_PATH = "/index.html";
const MANIFEST_PATH = "/manifest.json";
// Un manifeste encore frais dans le cache HTTP peut appartenir à l'ancienne version.
const MANIFEST_FETCH_OPTIONS = { cache: "reload" };
const ASSETS = [
  "/",
  APP_PATH,
  "/favicon.svg",
  "/favicon-32.png",
  "/apple-touch-icon.png",
  "/icon-512.png",
];

async function findCachedManifest(request) {
  const options = { cacheName: CACHE_NAME };
  const exact = await caches.match(request, options);
  if (exact?.ok) return exact;

  const canonical = await caches.match(MANIFEST_PATH, options);
  return canonical?.ok ? canonical : undefined;
}

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

  // Ne jamais intercepter ni mettre en cache les appels API ou les handshakes WebSocket
  if (
    requestUrl.pathname.startsWith("/api/") ||
    e.request.headers?.get?.("upgrade")?.toLowerCase() === "websocket"
  ) {
    return;
  }

  const isManifestRequest =
    requestUrl.pathname === MANIFEST_PATH ||
    e.request.destination === "manifest";
  const isNavigate = e.request.mode === "navigate";
  const isAppNavigation = isNavigate &&
    (requestUrl.pathname === "/" || requestUrl.pathname === APP_PATH);

  // Stratégie Network-First pour les requêtes de navigation (index.html) et le manifeste PWA
  // afin de toujours charger la version la plus récente tout en préservant le mode hors ligne
  if (isAppNavigation || isManifestRequest) {
    const fetchRequest =
      isManifestRequest && !isNavigate
        ? fetch(e.request, MANIFEST_FETCH_OPTIONS)
        : fetch(e.request);
    // Clé canonique sans query string pour ne jamais persister de jeton (?token=...) dans CacheStorage
    const cacheKey = isManifestRequest ? MANIFEST_PATH : APP_PATH;

    e.respondWith(
      fetchRequest
        .then(async (response) => {
          if (isManifestRequest && response.status >= 500 && response.status < 600) {
            try {
              return (await findCachedManifest(e.request)) ?? response;
            } catch (err) {
              console.warn("[sw] Cached manifest lookup failed", err);
              return response;
            }
          }
          if (response.ok && (isManifestRequest || (
            !response.redirected && /^text\/html(?:\s*;|\s*$)/i.test(response.headers.get("content-type") ?? "")
          ))) {
            const copy = response.clone();
            const cacheWrite = caches
              .open(CACHE_NAME)
              .then((cache) => cache.put(cacheKey, copy))
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
        .catch(async (err) => {
          const options = { cacheName: CACHE_NAME };
          const fallback = isManifestRequest
            ? await findCachedManifest(e.request)
            : await caches.match(APP_PATH, options);
          if (fallback) return fallback;
          throw err;
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


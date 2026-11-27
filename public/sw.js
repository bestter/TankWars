const CACHE_NAME = "tankwars-v8";
const APP_PATH = "/index.html";
const MANIFEST_PATH = "/manifest.json";
// Un manifeste encore frais dans le cache HTTP peut appartenir à l'ancienne version.
const MANIFEST_FETCH_OPTIONS = { cache: "reload" };
const ASSETS = [
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

function isStaticFilePath(pathname) {
  const normalized = pathname.replace(/\/+$/, "");
  const lastSegment = normalized.split("/").pop() || "";
  return lastSegment.includes(".");
}

function hasInvitationToken(urlLike) {
  if (!urlLike) return false;
  try {
    const parsed =
      urlLike instanceof URL ? urlLike : new URL(urlLike, self.location.origin);
    for (const key of parsed.searchParams.keys()) {
      if (key.toLowerCase() === "token") return true;
    }
    return false;
  } catch {
    return true;
  }
}

function isHtmlResponse(response) {
  return /^text\/html(?:\s*;|\s*$)/i.test(response.headers.get("content-type") ?? "");
}

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches
      .open(CACHE_NAME)
      .then(async (cache) => {
        // Cloudflare Pages redirige /index.html. Une navigation hors ligne
        // exige une réponse non redirigée, même sous la clé /index.html.
        const app = new Request(new URL("/", self.location.origin), {
          cache: "reload",
          redirect: "error",
        });
        const page = await fetch(app);
        if (!page.ok || !isHtmlResponse(page)) {
          throw new Error("[sw] App document precache failed");
        }
        const manifest = new Request(
          new URL(MANIFEST_PATH, self.location.origin),
          MANIFEST_FETCH_OPTIONS
        );
        await cache.addAll([...ASSETS, manifest]);
        await cache.put(APP_PATH, page);
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

  // Ignorer les requêtes cross-origin et les origines opaques pour éviter les violations de CSP
  if (
    requestUrl.origin === "null" ||
    self.location.origin === "null" ||
    requestUrl.origin !== self.location.origin
  ) {
    return;
  }

  // Ne jamais intercepter ni mettre en cache les appels API ou les handshakes WebSocket
  if (
    requestUrl.pathname === "/api" ||
    requestUrl.pathname.startsWith("/api/") ||
    e.request.headers?.get?.("upgrade")?.toLowerCase() === "websocket"
  ) {
    return;
  }

  const isManifestRequest =
    requestUrl.pathname === MANIFEST_PATH ||
    e.request.destination === "manifest";
  const isNavigate = e.request.mode === "navigate";
  const isCanonicalAppDocument =
    requestUrl.pathname === "/" || requestUrl.pathname === APP_PATH;
  const isAppNavigation =
    isNavigate &&
    !isManifestRequest &&
    (isCanonicalAppDocument || !isStaticFilePath(requestUrl.pathname));

  // Stratégie Network-First pour les navigations applicatives (repli vers index.html) et le manifeste PWA
  // afin de toujours charger la version la plus récente tout en préservant le mode hors ligne
  if (isAppNavigation || isManifestRequest) {
    const fetchRequest =
      isManifestRequest && !isNavigate
        ? fetch(e.request, MANIFEST_FETCH_OPTIONS)
        : fetch(e.request);
    // La clé et l’URL mémorisée dans la réponse sont deux valeurs distinctes.
    const cacheKey = isManifestRequest ? MANIFEST_PATH : APP_PATH;
    const requestHasToken = hasInvitationToken(requestUrl);

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
          const canCacheResponse =
            response.ok &&
            !requestHasToken &&
            !hasInvitationToken(response.url) &&
            !response.redirected &&
            (isManifestRequest || (isCanonicalAppDocument && isHtmlResponse(response)));
          if (canCacheResponse) {
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


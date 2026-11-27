/// <reference types="node" />
import { describe, it, expect, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'node:vm';

describe('Content Security Policy (CSP) Safety Checks', () => {
  it('should require style-src to allow unsafe-inline in index.html to prevent Vite and React UI breakage', () => {
    const indexPath = path.resolve(process.cwd(), 'index.html');
    const content = fs.readFileSync(indexPath, 'utf-8');

    // Regardons si la balise meta de CSP est présente
    expect(content).toContain('http-equiv="Content-Security-Policy"');

    // Recherchons spécifiquement la ligne contenant Content-Security-Policy
    const lines = content.split('\n');
    const cspLine = lines.find((l: string) => l.includes('Content-Security-Policy'));
    expect(cspLine).toBeDefined();

    const cspMatch = cspLine!.match(/content="([^"]+)"/);
    expect(cspMatch).not.toBeNull();

    const cspContent = cspMatch![1];
    const directives = cspContent.split(';').map((d: string) => d.trim()).filter(Boolean);
    const styleSrcDirective = directives.find((d: string) => d.startsWith('style-src'));

    expect(styleSrcDirective).toBeDefined();
    expect(styleSrcDirective).toContain("'unsafe-inline'");

    const scriptSrcDirective = directives.find((d: string) => d.startsWith('script-src'));
    expect(scriptSrcDirective).toContain('https://static.cloudflareinsights.com');
    expect(cspContent).toContain('https://cloudflareinsights.com');
    expect(cspContent).toContain('https://static.cloudflareinsights.com');

    const connectSrcDirective = directives.find((d: string) => d.startsWith('connect-src'));
    expect(connectSrcDirective).toBeDefined();
    const connectSrcTokens = connectSrcDirective!.split(/\s+/);
    expect(connectSrcTokens).not.toContain('ws:');
    expect(connectSrcTokens).not.toContain('wss:');
    expect(directives).toContain("object-src 'none'");
    expect(directives).toContain("base-uri 'none'");
    expect(directives).toContain("form-action 'none'");
    expect(content).toContain('<meta name="referrer" content="strict-origin-when-cross-origin" />');
  });

  it('should require style-src to allow unsafe-inline in public/_headers to prevent production UI breakage', () => {
    const headersPath = path.resolve(process.cwd(), 'public/_headers');
    const content = fs.readFileSync(headersPath, 'utf-8');

    // Regardons si l'en-tête CSP est présent
    expect(content).toContain('Content-Security-Policy:');

    // Vérifions que style-src contient 'unsafe-inline'
    const lines = content.split('\n');
    const cspLine = lines.find((l: string) => l.includes('Content-Security-Policy:'));

    expect(cspLine).toBeDefined();
    expect(cspLine).toContain('style-src');
    expect(cspLine).toContain("'unsafe-inline'");
    expect(cspLine).toContain('https://static.cloudflareinsights.com');
    expect(cspLine).toContain('https://cloudflareinsights.com');
    expect(cspLine).toContain("object-src 'none'");
    expect(cspLine).toContain("base-uri 'none'");
    expect(cspLine).toContain("form-action 'none'");
    expect(cspLine).toContain("frame-ancestors 'none'");
    expect(content).toContain('Permissions-Policy: camera=(), geolocation=(), microphone=()');
    expect(content).toContain('Cross-Origin-Opener-Policy: same-origin-allow-popups');

    const connectSrcMatch = cspLine!.match(/connect-src\s+([^;]+)/);
    expect(connectSrcMatch).not.toBeNull();
    const connectSrcTokens = connectSrcMatch![1].trim().split(/\s+/);
    expect(connectSrcTokens).not.toContain('ws:');
    expect(connectSrcTokens).not.toContain('wss:');
    expect(connectSrcTokens).not.toContain('http://localhost:8787');
    expect(connectSrcTokens).not.toContain('ws://localhost:8787');

    // Vérifions qu'aucune note non commentée n'est interprétée comme un en-tête HTTP
    const nonEmptyNonCommentLines = lines
      .map((l: string) => l.trim())
      .filter((l: string) => l.length > 0 && !l.startsWith('#') && l !== '/*');
    for (const headerLine of nonEmptyNonCommentLines) {
      expect(headerLine).toMatch(/^[A-Za-z-]+:\s+.+$/);
    }
  });
});

describe('Service worker cache strategy', () => {
  it('uses network-first for navigations and manifest.json while ignoring cross-origin fetches', () => {
    const swPath = path.resolve(process.cwd(), 'public/sw.js');
    const content = fs.readFileSync(swPath, 'utf-8');
    expect(content).toContain('const CACHE_NAME = "tankwars-v8"');
    expect(content).toContain('e.request.mode === "navigate"');
    expect(content).toContain('const MANIFEST_PATH = "/manifest.json"');
    expect(content).toContain('requestUrl.pathname === MANIFEST_PATH');
    expect(content).toContain('e.request.destination === "manifest"');
    expect(content).toContain('requestUrl.origin !== self.location.origin');
    expect(content).toContain('requestUrl.origin === "null"');
    expect(content).not.toContain('  "/",');
    expect(content).not.toContain('e.request.url.startsWith(self.location.origin)');
    expect(content).toContain('throw err');
  });

  it.each([
    ['prefers the exact manifest on HTTP 503', 503, 'exact', 'exact', ['/manifest.json?rev=2']],
    ['uses the canonical manifest on HTTP 503', 503, 'canonical', 'canonical', ['/manifest.json?rev=2', '/manifest.json']],
    ['returns HTTP 503 with no cached manifest', 503, 'empty', 'network', ['/manifest.json?rev=2', '/manifest.json']],
    ['rejects an invalid cached manifest on HTTP 503', 503, 'invalid', 'network', ['/manifest.json?rev=2', '/manifest.json']],
    ['returns HTTP 503 when Cache Storage fails', 503, 'unavailable', 'network', ['/manifest.json?rev=2']],
    ['passes through a manifest HTTP 404', 404, 'exact', 'network', []],
    ['passes through an ordinary navigation HTTP 503', 503, 'page', 'network', []],
  ] as const)('%s', async (_name, status, cache, expectedSource, lookups) => {
    const origin = 'https://tankwars.example';
    const route = cache === 'page' ? '/' : '/manifest.json?rev=2';
    const networkResponse = new Response('Server response', { status });
    const exact = new Response('{"orientation":"any","rev":2}');
    const canonical = new Response('{"orientation":"any"}');
    const cached = new Map<string, Response>();
    if (cache === 'exact') cached.set(route, exact);
    if (cache === 'exact' || cache === 'canonical') cached.set('/manifest.json', canonical);
    if (cache === 'invalid') cached.set(route, new Response('Invalid entry', { status: 500 }));
    if (cache === 'page') cached.set(route, new Response('Cached navigation'));
    const match = vi.fn<(request: string | { url: string }, options: { cacheName: string }) => Promise<Response | undefined>>(async (request) => {
      if (cache === 'unavailable') throw new Error('Cache Storage unavailable');
      const url = new URL(typeof request === 'string' ? request : request.url, origin);
      return cached.get(`${url.pathname}${url.search}`);
    });
    const open = vi.fn();
    const listeners = new Map<string, (event: {
      request: { url: string; method: string; mode: string; destination: string };
      respondWith: (response: Promise<Response>) => void;
    }) => void>();
    vm.runInNewContext(fs.readFileSync(path.resolve(process.cwd(), 'public/sw.js'), 'utf-8'), {
      self: { location: { origin }, addEventListener: listeners.set.bind(listeners) },
      fetch: async () => networkResponse,
      caches: { match, open },
      console: { warn: vi.fn() },
      URL,
    });

    let pending: Promise<Response> | undefined;
    listeners.get('fetch')?.({
      request: {
        url: `${origin}${route}`,
        method: 'GET',
        mode: route === '/' ? 'navigate' : 'cors',
        destination: route === '/' ? 'document' : 'manifest',
      },
      respondWith(response) { pending = response; },
    });

    const responses = { exact, canonical, network: networkResponse };
    expect(await pending).toBe(responses[expectedSource]);
    expect(match.mock.calls.map(([input, options]) => {
      expect(options).toEqual({ cacheName: 'tankwars-v8' });
      const url = new URL(typeof input === 'string' ? input : input.url, origin);
      return `${url.pathname}${url.search}`;
    })).toEqual(lookups);
    expect(open).not.toHaveBeenCalled();
  });

  it('caches only canonical app documents without query tokens, falls back offline for app routes, and skips static files and /api/ routes', async () => {
    const origin = 'https://tankwars.example';
    const stored = new Map<string, Response>();
    const open = vi.fn(async () => ({
      put: vi.fn(async (key: string | Request, value: Response) => {
        stored.set(typeof key === 'string' ? key : key.url, value);
      }),
    }));
    const match = vi.fn(async (key: string | Request) => {
      const k = typeof key === 'string' ? key : key.url;
      return stored.get(k)?.clone();
    });
    const listeners = new Map<string, (event: {
      request: { url: string; method: string; mode: string; destination: string; headers?: { get: (name: string) => string | null } };
      waitUntil: (promise: Promise<unknown>) => void;
      respondWith: (response: Promise<Response>) => void;
    }) => void>();
    let networkShouldFail = false;
    const fetchMock = vi.fn(async (request: { url: string }) => {
      if (networkShouldFail) throw new Error('Offline');
      const url = new URL(request.url);
      if (url.pathname === '/robots.txt' || url.searchParams.has('plain')) {
        return new Response('User-agent: *', { headers: { 'Content-Type': 'text/plain' } });
      }
      let html = '<html>app</html>';
      if (url.pathname === '/other.html') html = '<html>other</html>';
      else if (url.pathname === '/guide' || url.pathname === '/guide/') html = '<html>guide</html>';
      const responseUrl = url.searchParams.has('leakTokenInRes')
        ? `${origin}/?token=leaked-in-response`
        : url.href;
      const response = new Response(html, { headers: { 'Content-Type': 'text/html; charset=UTF-8' } });
      const attachUrl = (target: Response): Response => {
        Object.defineProperty(target, 'url', { value: responseUrl });
        const origClone = target.clone.bind(target);
        target.clone = () => attachUrl(origClone());
        return target;
      };
      return attachUrl(response);
    });

    vm.runInNewContext(fs.readFileSync(path.resolve(process.cwd(), 'public/sw.js'), 'utf-8'), {
      self: { location: { origin }, addEventListener: listeners.set.bind(listeners) },
      fetch: fetchMock,
      caches: { match, open },
      console: { warn: vi.fn() },
      URL,
    });

    const dispatch = async (req: { url: string; method: string; mode: string; destination: string; upgrade?: string }) => {
      let pending: Promise<Response> | undefined;
      const waits: Promise<unknown>[] = [];
      listeners.get('fetch')?.({
        request: {
          url: req.url,
          method: req.method,
          mode: req.mode,
          destination: req.destination,
          headers: { get: (name: string) => (name.toLowerCase() === 'upgrade' ? req.upgrade ?? null : null) },
        },
        waitUntil: (p) => { waits.push(p); },
        respondWith: (p) => { pending = p; },
      });
      const res = pending ? await pending : undefined;
      await Promise.all(waits);
      return res;
    };

    const navigate = (url: string) => dispatch({ url: `${origin}${url}`, method: 'GET', mode: 'navigate', destination: 'document' });
    expect((await navigate('/'))?.status).toBe(200);
    expect(await (await navigate('/guide'))?.text()).toBe('<html>guide</html>');
    expect(await (await navigate('/guide/'))?.text()).toBe('<html>guide</html>');

    const invitation = '/?room=r1&slot=1&token=secret-token';
    const guideInvitation = '/guide?room=r1&slot=1&token=secret-guide-token';
    const upperToken = '/?TOKEN=upper-secret';
    const leakedInResponse = '/?leakTokenInRes=1';
    expect((await navigate(invitation))?.url).toBe(`${origin}${invitation}`);
    expect((await navigate(guideInvitation))?.url).toBe(`${origin}${guideInvitation}`);
    expect((await navigate(upperToken))?.url).toBe(`${origin}${upperToken}`);
    expect((await navigate(leakedInResponse))?.url).toBe(`${origin}/?token=leaked-in-response`);

    expect([...stored.keys()]).toEqual(['/index.html']);
    expect(stored.get('/index.html')?.url).toBe(`${origin}/`);
    for (const [key, cachedRes] of stored.entries()) {
      expect(key.toLowerCase()).not.toContain('token');
      expect(cachedRes.url.toLowerCase()).not.toContain('token');
    }

    expect(await (await navigate('/robots.txt'))?.text()).toBe('User-agent: *');
    expect(await (await navigate('/other.html'))?.text()).toBe('<html>other</html>');
    expect(await (await navigate('/index.html?plain'))?.text()).toBe('User-agent: *');
    expect([...stored.keys()]).toEqual(['/index.html']);

    networkShouldFail = true;
    const offlineGuideRes = await navigate('/guide');
    expect(await offlineGuideRes?.text()).toBe('<html>app</html>');
    expect(offlineGuideRes?.url).toBe(`${origin}/`);

    const offlineNavRes = await navigate('/guide?room=r1&slot=1&token=other-token');
    expect(await offlineNavRes?.text()).toBe('<html>app</html>');
    expect(offlineNavRes?.url).toBe(`${origin}/`);
    expect(match).toHaveBeenCalledWith('/index.html', { cacheName: 'tankwars-v8' });

    await expect(navigate('/robots.txt')).rejects.toThrow('Offline');
    await expect(navigate('/other.html')).rejects.toThrow('Offline');

    fetchMock.mockClear();
    expect(await dispatch({ url: `${origin}/api/health`, method: 'GET', mode: 'navigate', destination: 'document' })).toBeUndefined();
    expect(await dispatch({ url: `${origin}/api`, method: 'GET', mode: 'navigate', destination: 'document' })).toBeUndefined();
    expect(await dispatch({ url: `${origin}/api/rooms/r1/ws`, method: 'GET', mode: 'cors', destination: '', upgrade: 'websocket' })).toBeUndefined();
    expect(await dispatch({ url: 'data:text/html,hi', method: 'GET', mode: 'navigate', destination: 'document' })).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('precaches the app before its first offline navigation and refreshes a stale HTTP manifest', async () => {
    interface MockResponse {
      ok: boolean;
      body: string;
      headers: Headers;
      redirected: boolean;
      clone: () => MockResponse;
    }

    interface MockRequest {
      url: string;
      method?: string;
      mode?: string;
      destination?: string;
      cache?: RequestCache;
      redirect?: RequestRedirect;
    }

    type SwEventHandler = (event: {
      request?: MockRequest;
      waitUntil?: (promise: Promise<unknown>) => void;
      respondWith?: (promise: Promise<MockResponse | undefined>) => void;
    }) => void;

    const makeResponse = (body: string, redirected = false, contentType = ''): MockResponse => ({
      ok: true,
      body,
      headers: new Headers({ 'content-type': contentType }),
      redirected,
      clone() {
        return makeResponse(body, redirected, contentType);
      },
    });

    const swPath = path.resolve(process.cwd(), 'public/sw.js');
    const content = fs.readFileSync(swPath, 'utf-8');
    const origin = 'https://tankwars.example';

    let httpCachedManifest = '{"orientation":"landscape"}';
    const cacheStorage = new Map<string, Map<string, MockResponse>>([
      ['tankwars-v3', new Map([['/manifest.json', makeResponse(httpCachedManifest)]])],
    ]);

    let networkAvailable = true;
    let httpCacheFresh = true;
    let networkManifestBody = '{"orientation":"any"}';
    const networkCalls: string[] = [];
    let skipWaitingCalled = false;
    let clientsClaimCalled = false;

    const resolveKey = (input: string | MockRequest): string => {
      const rawUrl = typeof input === 'string' ? input : input.url;
      return new URL(rawUrl, origin).pathname;
    };

    const mockFetch = async (
      input: string | MockRequest,
      options?: RequestInit,
    ): Promise<MockResponse> => {
      const key = resolveKey(input);
      const cacheMode = options?.cache ?? (typeof input === 'string' ? undefined : input.cache);
      if (httpCacheFresh && key === '/manifest.json' && cacheMode !== 'reload' && cacheMode !== 'no-cache') {
        return makeResponse(httpCachedManifest);
      }
      networkCalls.push(key);
      if (!networkAvailable) {
        throw new Error('Offline');
      }
      if (key === '/manifest.json') {
        httpCachedManifest = networkManifestBody;
        return makeResponse(httpCachedManifest);
      }
      if (key === '/' || key === '/index.html') {
        const redirected = key === '/index.html';
        if (redirected && (typeof input !== 'string' && input.redirect === 'error')) {
          throw new TypeError('Unexpected redirect');
        }
        return makeResponse('<html>TankWars</html>', redirected, 'text/html; charset=UTF-8');
      }
      return makeResponse(`asset:${key}`);
    };

    const mockCaches = {
      async open(cacheName: string) {
        let store = cacheStorage.get(cacheName);
        if (!store) {
          store = new Map();
          cacheStorage.set(cacheName, store);
        }
        return {
          async addAll(requests: (string | MockRequest)[]) {
            for (const request of requests) {
              const response = await mockFetch(request);
              store!.set(resolveKey(request), response);
            }
          },
          async put(request: string | MockRequest, response: MockResponse) {
            store!.set(resolveKey(request), response);
          },
        };
      },
      async keys() {
        return Array.from(cacheStorage.keys());
      },
      async delete(cacheName: string) {
        return cacheStorage.delete(cacheName);
      },
      async match(request: string | MockRequest, options?: { cacheName?: string }) {
        const key = resolveKey(request);
        if (options?.cacheName) {
          return cacheStorage.get(options.cacheName)?.get(key);
        }
        for (const store of cacheStorage.values()) {
          const hit = store.get(key);
          if (hit) {
            return hit;
          }
        }
        return undefined;
      },
    };

    const listeners = new Map<string, SwEventHandler>();
    const swSelf = {
      location: { origin },
      addEventListener(type: string, handler: SwEventHandler) {
        listeners.set(type, handler);
      },
      async skipWaiting() {
        skipWaitingCalled = true;
      },
      clients: {
        async claim() {
          clientsClaimCalled = true;
        },
      },
    };

    vm.runInNewContext(content, {
      self: swSelf,
      caches: mockCaches,
      fetch: mockFetch,
      Request,
      URL,
      Promise,
      Error,
    });

    const installPromises: Promise<unknown>[] = [];
    listeners.get('install')?.({
      waitUntil(promise) {
        installPromises.push(promise);
      },
    });
    await Promise.all(installPromises);

    const activatePromises: Promise<unknown>[] = [];
    listeners.get('activate')?.({
      waitUntil(promise) {
        activatePromises.push(promise);
      },
    });
    await Promise.all(activatePromises);

    expect(skipWaitingCalled).toBe(true);
    expect(clientsClaimCalled).toBe(true);
    expect(cacheStorage.has('tankwars-v3')).toBe(false);
    expect(cacheStorage.get('tankwars-v8')?.get('/manifest.json')?.body)
      .toBe('{"orientation":"any"}');
    expect(networkCalls).toContain('/manifest.json');
    expect(networkCalls).toContain('/');
    expect(networkCalls).not.toContain('/index.html');
    expect(cacheStorage.get('tankwars-v8')?.has('/')).toBe(false);

    const respondWithFetch = async (request: MockRequest): Promise<MockResponse | undefined> => {
      let pending: Promise<MockResponse | undefined> | undefined;
      const waitUntilPromises: Promise<unknown>[] = [];
      listeners.get('fetch')?.({
        request,
        waitUntil(promise) {
          waitUntilPromises.push(promise);
        },
        respondWith(promise) {
          pending = promise;
        },
      });
      const response = await pending;
      await Promise.all(waitUntilPromises);
      return response;
    };

    networkAvailable = false;
    for (const route of ['/', '/guide']) {
      const response = await respondWithFetch({ url: `${origin}${route}`, mode: 'navigate', destination: 'document' });
      expect(response).toMatchObject({ body: '<html>TankWars</html>', redirected: false });
    }
    networkAvailable = true;

    networkCalls.length = 0;
    const crossOriginPrefixed = await respondWithFetch({
      url: `${origin}.attacker.test/manifest.json`,
      mode: 'cors',
      destination: 'manifest',
    });
    expect(crossOriginPrefixed).toBeUndefined();
    expect(networkCalls).toEqual([]);

    const headManifest = await respondWithFetch({
      url: `${origin}/manifest.json`,
      method: 'HEAD',
      mode: 'cors',
      destination: 'manifest',
    });
    expect(headManifest).toBeUndefined();
    expect(networkCalls).toEqual([]);

    const postManifest = await respondWithFetch({
      url: `${origin}/manifest.json`,
      method: 'POST',
      mode: 'cors',
      destination: 'manifest',
    });
    expect(postManifest).toBeUndefined();
    expect(networkCalls).toEqual([]);

    networkCalls.length = 0;
    networkManifestBody = '{"orientation":"any","rev":2}';
    const onlineManifest = await respondWithFetch({
      url: `${origin}/manifest.json`,
      mode: 'cors',
      destination: 'manifest',
    });
    expect(onlineManifest?.body).toBe('{"orientation":"any","rev":2}');
    expect(networkCalls).toEqual(['/manifest.json']);

    networkAvailable = false;
    networkCalls.length = 0;
    const offlineManifest = await respondWithFetch({
      url: `${origin}/manifest.json`,
      mode: 'cors',
      destination: 'manifest',
    });
    expect(offlineManifest?.body).toBe('{"orientation":"any","rev":2}');
    expect(networkCalls).toEqual(['/manifest.json']);

    httpCacheFresh = false;
    networkCalls.length = 0;
    const offlineManifestNavigation = await respondWithFetch({
      url: `${origin}/manifest.json?source=direct`,
      mode: 'navigate',
      destination: 'document',
    });
    expect(offlineManifestNavigation?.body).toBe('{"orientation":"any","rev":2}');
    expect(networkCalls).toEqual(['/manifest.json']);

    networkCalls.length = 0;
    const offlineIcon = await respondWithFetch({
      url: `${origin}/icon-512.png`,
      mode: 'no-cors',
      destination: 'image',
    });
    expect(offlineIcon?.body).toBe('asset:/icon-512.png');
    expect(networkCalls).toEqual([]);
  });
});

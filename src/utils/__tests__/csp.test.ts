/// <reference types="node" />
import { describe, it, expect } from 'vitest';
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

    const connectSrcMatch = cspLine!.match(/connect-src\s+([^;]+)/);
    expect(connectSrcMatch).not.toBeNull();
    const connectSrcTokens = connectSrcMatch![1].trim().split(/\s+/);
    expect(connectSrcTokens).not.toContain('ws:');
    expect(connectSrcTokens).not.toContain('wss:');

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
    expect(content).toContain('const CACHE_NAME = "tankwars-v4"');
    expect(content).toContain('e.request.mode === "navigate"');
    expect(content).toContain('const MANIFEST_PATH = "/manifest.json"');
    expect(content).toContain('requestUrl.pathname === MANIFEST_PATH');
    expect(content).toContain('e.request.destination === "manifest"');
    expect(content).toContain('requestUrl.origin !== self.location.origin');
    expect(content).not.toContain('e.request.url.startsWith(self.location.origin)');
    expect(content).toContain('throw err');
  });

  it('refreshes a manifest with a fresh HTTP cache entry during installation and online, and keeps it offline', async () => {
    interface MockResponse {
      ok: boolean;
      body: string;
      clone: () => MockResponse;
    }

    interface MockRequest {
      url: string;
      method?: string;
      mode?: string;
      destination?: string;
      cache?: RequestCache;
    }

    type SwEventHandler = (event: {
      request?: MockRequest;
      waitUntil?: (promise: Promise<unknown>) => void;
      respondWith?: (promise: Promise<MockResponse | undefined>) => void;
    }) => void;

    const makeResponse = (body: string, ok = true): MockResponse => ({
      ok,
      body,
      clone() {
        return makeResponse(body, ok);
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
    expect(cacheStorage.get('tankwars-v4')?.get('/manifest.json')?.body)
      .toBe('{"orientation":"any"}');
    expect(networkCalls).toContain('/manifest.json');

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

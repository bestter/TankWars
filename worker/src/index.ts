/**
 * TankWars Online - Worker entry (src/worker/index.ts)
 * Routes REST for room creation/join + WebSocket upgrade to the GameRoom Durable Object.
 * Lobby coordination and authoritative online state live in the DO; combat physics remains client-side.
 *
 * Usage:
 * - Client creates room via POST /api/rooms
 * - Joins via WS to /api/rooms/:roomId/ws?slot=0&token=xxx
 * - No external deps beyond Cloudflare runtime (fetch, WebSocket, DurableObject).
 */

// IMPORTANT: Durable Object classes MUST be re-exported from the entrypoint (the file
// pointed to by "main" in wrangler.toml). Wrangler validates this at startup.
export { GameRoom } from './game-room';
export { RateLimiter } from './rate-limiter';

import {
  MINIMUM_CLIENT_PROTOCOL_VERSION,
  ONLINE_PROTOCOL_VERSION,
} from '../../src/game/online/protocol';
import { CONTACT_RATE_LIMIT_PATH, ROOM_RATE_LIMIT_PATH, WEBSOCKET_RATE_LIMIT_PATH } from './rate-limiter';
import { handleContact, type ContactEmailEnv } from './contact';

// Env bindings injected by wrangler (see wrangler.toml)
export interface Env extends ContactEmailEnv {
  GAME_ROOM: DurableObjectNamespace;
  RATE_LIMITER: DurableObjectNamespace;
  ALLOW_LOCAL_ORIGINS?: string;
}

const RATE_LIMIT_BUCKETS = {
  rooms: { prefix: 'rate_limit_', path: ROOM_RATE_LIMIT_PATH },
  websocket: { prefix: 'ws_rate_limit_', path: WEBSOCKET_RATE_LIMIT_PATH },
  contact: { prefix: 'contact_rate_limit_', path: CONTACT_RATE_LIMIT_PATH },
} as const;
const TEXT_ENCODER = new TextEncoder();
const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function normalizeClientIp(rawIp: string): string {
  if (!rawIp.includes(':')) return rawIp;
  const addr = rawIp.split('%')[0].trim().toLowerCase();
  const [headPart, tailPart, extra] = addr.split('::');
  if (extra !== undefined) return rawIp;

  const parseSide = (part: string, allowIpv4: boolean): string[] | null => {
    if (!part) return [];
    const tokens = part.split(':');
    const out: string[] = [];
    for (let i = 0; i < tokens.length; i++) {
      const tok = tokens[i];
      if (tok.includes('.')) {
        if (!allowIpv4 || i !== tokens.length - 1) return null;
        const octets = tok.split('.');
        if (octets.length !== 4 || octets.some((o) => !/^\d{1,3}$/.test(o) || Number(o) > 255)) return null;
        const n = octets.map((o) => Number(o));
        out.push(((n[0] << 8) | n[1]).toString(16).padStart(4, '0'));
        out.push(((n[2] << 8) | n[3]).toString(16).padStart(4, '0'));
      } else {
        if (!/^[0-9a-f]{1,4}$/.test(tok)) return null;
        out.push(tok.padStart(4, '0'));
      }
    }
    return out;
  };

  const head = parseSide(headPart, tailPart === undefined);
  if (!head) return rawIp;
  let full: string[];
  if (tailPart !== undefined) {
    const tail = parseSide(tailPart, true);
    if (!tail || head.length + tail.length >= 8) return rawIp;
    const missing = 8 - head.length - tail.length;
    full = [...head, ...Array.from({ length: missing }, () => '0000'), ...tail];
  } else {
    if (head.length !== 8) return rawIp;
    full = head;
  }
  if (
    full[0] === '0000' &&
    full[1] === '0000' &&
    full[2] === '0000' &&
    full[3] === '0000' &&
    full[4] === '0000' &&
    (full[5] === 'ffff' || (full[5] === '0000' && full[6] !== '0000'))
  ) {
    const hi = parseInt(full[6], 16);
    const lo = parseInt(full[7], 16);
    return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
  }
  return `${full.slice(0, 4).join(':')}::/64`;
}

const isHeaderSafeToken = (value: string): boolean => {
  if (value.length === 0 || value.length > 256 || value.trim() !== value) return false;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f || code > 0xff) return false;
  }
  return true;
};

// Simple REST + WS router. In production you may front this with a custom domain
// or route /api/* through the worker while Pages serves the SPA.
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const { pathname, searchParams } = url;
    const isWebSocketUpgrade = request.headers.get('Upgrade')?.toLowerCase() === 'websocket';

    const origin = request.headers.get('Origin');
    const allowLocalOrigins =
      url.hostname === 'localhost' ||
      url.hostname === '127.0.0.1' ||
      env.ALLOW_LOCAL_ORIGINS === 'true';
    const isAllowedOrigin = origin && (
      origin === 'https://tankwars-game.com' ||
      origin === 'https://tankwars.pages.dev' ||
      /^https:\/\/[a-zA-Z0-9-]+\.tankwars\.pages\.dev$/.test(origin) ||
      (allowLocalOrigins && (
        /^http:\/\/localhost:(5173|4173|8787)$/.test(origin) ||
        /^http:\/\/127\.0\.0\.1:(5173|4173|8787)$/.test(origin)
      ))
    );
    const allowedOrigin = isAllowedOrigin ? origin : 'https://tankwars.pages.dev';

    // Add CORS and security headers to HTTP responses. WebSocket upgrade responses
    // are returned untouched below so their Cloudflare-specific `webSocket` is preserved.
    const withResponseHeaders = (res: Response): Response => {
      const headers = new Headers(res.headers);
      headers.set('Access-Control-Allow-Origin', allowedOrigin);
      if (pathname === '/api/contact') {
        headers.set('Access-Control-Expose-Headers', 'Retry-After');
        headers.set('Cache-Control', 'no-store');
      }
      const existingVary = headers.get('Vary');
      if (!existingVary || !existingVary.split(',').some((v) => v.trim().toLowerCase() === 'origin')) {
        headers.append('Vary', 'Origin');
      }
      headers.set('X-Content-Type-Options', 'nosniff');
      headers.set('X-Frame-Options', 'DENY');
      headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
      return new Response(res.body, {
        status: res.status,
        statusText: res.statusText,
        headers,
      });
    };

    const enforceRateLimit = async (scope: keyof typeof RATE_LIMIT_BUCKETS = 'rooms'): Promise<Response | null> => {
      // Cloudflare supplies this header in production. Local/non-proxied requests
      // without it share one 'unknown' bucket; never trust a client-supplied fallback IP.
      const ip = normalizeClientIp(request.headers.get('cf-connecting-ip') || 'unknown');
      const { prefix, path } = RATE_LIMIT_BUCKETS[scope];
      const limiterName = prefix + ip;

      // Bound the complete identifier in UTF-8 bytes, including our namespace prefix.
      if (TEXT_ENCODER.encode(limiterName).byteLength > 256) {
        return new Response(JSON.stringify({ error: 'Invalid IP identifier' }), {
          status: 400,
          headers: { 'content-type': 'application/json' },
        });
      }

      try {
        const id = env.RATE_LIMITER.idFromName(limiterName);
        const response = await env.RATE_LIMITER.get(id).fetch(`https://internal${path}`, {
          method: 'POST',
        });
        const retryAfter = response.headers.get('Retry-After');
        if (response.status === 429 && retryAfter !== null && /^[1-9]\d*$/.test(retryAfter)) {
          return new Response(JSON.stringify({ error: 'Too Many Requests' }), {
            status: 429,
            headers: { 'content-type': 'application/json', 'Retry-After': retryAfter },
          });
        }
        if (response.status !== 204) {
          throw new Error(`Unexpected rate limiter response: ${response.status}`);
        }
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.error(`[Worker] Rate limiter unavailable or failed (${scope}):`, errorMessage);

        // Fail closed for limiter failures to prevent bypassing rate limit
        return new Response(JSON.stringify({ error: 'Internal Server Error' }), {
          status: 500,
          headers: { 'content-type': 'application/json' },
        });
      }
      return null;
    };

    if (pathname === '/api/contact' && !isAllowedOrigin &&
      (request.method === 'POST' || request.method === 'OPTIONS')) {
      return withResponseHeaders(Response.json({ error: 'Forbidden: Invalid Origin' }, { status: 403 }));
    }

    // CORS preflight handling (required for cross-origin POST from Vite dev server on :5173 to worker on :8787)
    if (request.method === 'OPTIONS') {
      return withResponseHeaders(new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, x-room-id, x-slot, x-token',
          'Access-Control-Max-Age': '86400',
        },
      }));
    }

    // Health / version for easy checks during dev
    if (pathname === '/api/health') {
      return withResponseHeaders(new Response(JSON.stringify({
        ok: true,
        service: 'tankwars-api',
        protocolVersion: ONLINE_PROTOCOL_VERSION,
        minimumClientProtocolVersion: MINIMUM_CLIENT_PROTOCOL_VERSION,
        time: Date.now(),
      }), {
        headers: { 'content-type': 'application/json' },
      }));
    }

    const rejectRestUpgrade = () => withResponseHeaders(Response.json({
      error: 'Use the WebSocket endpoint for an upgrade',
    }, { status: 400 }));

    if (pathname === '/api/contact') {
      if (isWebSocketUpgrade) return rejectRestUpgrade();
      if (request.method !== 'POST') {
        return withResponseHeaders(new Response('Method not allowed', { status: 405, headers: { Allow: 'POST, OPTIONS' } }));
      }
      return withResponseHeaders(await handleContact(request, env, () => enforceRateLimit('contact')));
    }

    // POST /api/rooms  -> create a new room, return roomId + per-slot join URLs/tokens
    if (pathname === '/api/rooms' && request.method === 'POST') {
      // Strict origin validation to prevent CSRF
      if (origin !== null && !isAllowedOrigin) {
        return withResponseHeaders(new Response(JSON.stringify({ error: 'Forbidden: Invalid Origin' }), {
          status: 403,
          headers: { 'content-type': 'application/json' },
        }));
      }

      if (isWebSocketUpgrade) return rejectRestUpgrade();

      const rateLimitResponse = await enforceRateLimit();
      if (rateLimitResponse) {
        return withResponseHeaders(rateLimitResponse);
      }
      // The client sends { numPlayers: 2|3|4, slots: Array<{type: 'human'|'ai', aiProfile?: string}> }
      // Normalize the external payload before forwarding the room configuration to the DO.
      let body: Record<string, unknown> = {};
      try {
        const parsed = await request.json();
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          body = parsed as Record<string, unknown>;
        }
      } catch {
        body = {};
      }

      const numPlayers = Math.floor(Math.max(2, Math.min(4, Number(body.numPlayers) || 2)));
      const validAiProfiles = ['v1-random', 'v2-heuristic', 'v3-sniper', 'v4-smart'] as const;
      type SlotAiProfile = (typeof validAiProfiles)[number];
      const isSlotAiProfile = (value: unknown): value is SlotAiProfile =>
        typeof value === 'string' && (validAiProfiles as readonly string[]).includes(value);
      const slotConfigs: Array<{ type: 'human' | 'ai'; aiProfile?: SlotAiProfile }> =
        Array.isArray(body.slots) && body.slots.length === numPlayers
          ? body.slots.map((s: unknown) => {
              const obj = typeof s === 'object' && s !== null ? (s as Record<string, unknown>) : {};
              const type = obj.type === 'ai' ? 'ai' as const : 'human' as const;
              if (type !== 'ai') {
                return { type };
              }
              return isSlotAiProfile(obj.aiProfile)
                ? { type, aiProfile: obj.aiProfile }
                : { type };
            })
          : Array.from({ length: numPlayers }, (_, i) => (
              i === 0 ? { type: 'human' as const } : { type: 'ai' as const }
            ));

      // Create a room code. Real token/secret is generated inside the DO.
      const roomId = crypto.randomUUID(); // Secure id for URLs

      // Get (or create) the DO instance for this roomId
      const id = env.GAME_ROOM.idFromName(roomId);
      const stub = env.GAME_ROOM.get(id);

      // Delegate creation to the DO (it will store the config + generate per-slot secrets)
      // Use the server-validated allowedOrigin instead of trusting body.origin
      const createResp = await stub.fetch('https://internal/create', {
        method: 'POST',
        body: JSON.stringify({ roomId, numPlayers, slotConfigs, origin: allowedOrigin }),
        headers: { 'content-type': 'application/json' },
      });

      if (!createResp.ok) {
        const errorText = await createResp.text();
        if (createResp.status >= 500) {
          console.error('[Worker] create room 500 error:', errorText);
          return withResponseHeaders(new Response(JSON.stringify({ error: 'Internal Server Error' }), {
            status: createResp.status,
            headers: { 'content-type': 'application/json' },
          }));
        }
        return withResponseHeaders(new Response(errorText || JSON.stringify({ error: 'Error creating room' }), {
          status: createResp.status,
          headers: { 'content-type': createResp.headers.get('content-type') || 'application/json' },
        }));
      }

      const data = await createResp.json();
      return withResponseHeaders(new Response(JSON.stringify(data), {
        headers: { 'content-type': 'application/json' },
      }));
    }

    // POST /api/rooms/:roomId/join (optional REST fallback; primary join is via WS)
    if (pathname.startsWith('/api/rooms/') && pathname.endsWith('/join') && request.method === 'POST') {
      // Strict origin validation to prevent CSRF
      if (origin !== null && !isAllowedOrigin) {
        return withResponseHeaders(new Response(JSON.stringify({ error: 'Forbidden: Invalid Origin' }), {
          status: 403,
          headers: { 'content-type': 'application/json' },
        }));
      }
      if (isWebSocketUpgrade) return rejectRestUpgrade();
      const parts = pathname.split('/');
      const roomId = parts[3];
      if (parts.length !== 5 || !roomId || !UUID_V4_RE.test(roomId)) {
        return withResponseHeaders(new Response(JSON.stringify({ error: 'Invalid room ID' }), {
          status: 400,
          headers: { 'content-type': 'application/json' },
        }));
      }
      const rateLimitResponse = await enforceRateLimit();
      if (rateLimitResponse) {
        return withResponseHeaders(rateLimitResponse);
      }
      const id = env.GAME_ROOM.idFromName(roomId);
      const stub = env.GAME_ROOM.get(id);
      const joinResp = await stub.fetch(request);
      const joinText = await joinResp.text();
      if (!joinResp.ok) {
        if (joinResp.status >= 500) {
          console.error('[Worker] join room 500 error:', joinText);
          return withResponseHeaders(new Response(JSON.stringify({ error: 'Internal Server Error' }), {
            status: joinResp.status,
            headers: { 'content-type': 'application/json' },
          }));
        }
        return withResponseHeaders(new Response(JSON.stringify({ error: joinText || 'Error joining room' }), {
          status: joinResp.status,
          headers: { 'content-type': 'application/json' },
        }));
      }
      return withResponseHeaders(new Response(joinText, {
        status: joinResp.status,
        headers: { 'content-type': 'application/json' },
      }));
    }

    // WebSocket upgrade: /api/rooms/:roomId/ws?slot=0&token=SECRET
    if (pathname.startsWith('/api/rooms/') && pathname.endsWith('/ws')) {
      const parts = pathname.split('/');
      const roomId = parts[3];

      // Strict origin validation for WebSocket to prevent CSRF/Cross-Site WebSocket Hijacking
      if (origin !== null && !isAllowedOrigin) {
        return withResponseHeaders(new Response('Forbidden: Invalid Origin', { status: 403 }));
      }
      if (parts.length !== 5 || !roomId || !UUID_V4_RE.test(roomId)) {
        return withResponseHeaders(new Response('Missing or invalid room/slot/token', { status: 400 }));
      }
      if (request.method !== 'GET') {
        return withResponseHeaders(new Response('Method not allowed', { status: 405, headers: { Allow: 'GET' } }));
      }
      if (!isWebSocketUpgrade) {
        return withResponseHeaders(new Response('WebSocket upgrade required', { status: 426, headers: { Upgrade: 'websocket' } }));
      }

      const slot = searchParams.get('slot');
      const token = searchParams.get('token');
      if (slot === null || !/^[0-3]$/.test(slot) || token === null || !isHeaderSafeToken(token)) {
        return withResponseHeaders(new Response('Missing or invalid room/slot/token', { status: 400 }));
      }

      const rateLimitResponse = await enforceRateLimit('websocket');
      if (rateLimitResponse) return withResponseHeaders(rateLimitResponse);

      const id = env.GAME_ROOM.idFromName(roomId);
      const stub = env.GAME_ROOM.get(id);

      // Forward the upgrade request to the specific DO instance (it will accept the WS)
      const upgradeReq = new Request(request, {
        headers: {
          ...Object.fromEntries(request.headers),
          upgrade: 'websocket',
          'x-room-id': roomId,
          'x-slot': slot,
          'x-token': token,
        },
      });
      return stub.fetch(upgradeReq);
    }

    // Fallback
    return withResponseHeaders(new Response('Not found. TankWars Online API. See /api/health', { status: 404 }));
  },
} satisfies ExportedHandler<Env>;

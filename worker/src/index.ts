/**
 * TankWars Online - Worker entry (src/worker/index.ts)
 * Routes REST for room creation/join + WebSocket upgrade to the GameRoom Durable Object.
 * All game lobby coordination and authoritative simulation (MVP 1-round) lives in the DO.
 *
 * Usage:
 * - Client creates room via POST /api/rooms
 * - Joins via WS to /api/rooms/:roomId/ws?slot=0&token=xxx
 * - No external deps beyond Cloudflare runtime (fetch, WebSocket, DurableObject).
 */

// IMPORTANT: Durable Object classes MUST be re-exported from the entrypoint (the file
// pointed to by "main" in wrangler.toml). Wrangler validates this at startup.
export { GameRoom } from './game-room';

import {
  MINIMUM_CLIENT_PROTOCOL_VERSION,
  ONLINE_PROTOCOL_VERSION,
} from '../../src/game/online/protocol';

// Env bindings injected by wrangler (see wrangler.toml)
export interface Env {
  GAME_ROOM: DurableObjectNamespace;
}

// Simple REST + WS router. In production you may front this with a custom domain
// or route /api/* through the worker while Pages serves the SPA.
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const { pathname, searchParams } = url;

    const origin = request.headers.get('Origin');
    const isAllowedOrigin = origin && (
      origin === 'https://tankwars.pages.dev' ||
      /^https:\/\/[a-zA-Z0-9-]+\.tankwars\.pages\.dev$/.test(origin) ||
      /^http:\/\/localhost:(5173|4173|8787)$/.test(origin) ||
      /^http:\/\/127\.0\.0\.1:(5173|4173|8787)$/.test(origin)
    );
    const allowedOrigin = isAllowedOrigin ? origin : 'https://tankwars.pages.dev';

    // Add CORS and security headers to HTTP responses. WebSocket upgrade responses
    // are returned untouched below so their Cloudflare-specific `webSocket` is preserved.
    const withResponseHeaders = (res: Response): Response => {
      const headers = new Headers(res.headers);
      headers.set('Access-Control-Allow-Origin', allowedOrigin);
      headers.set('X-Content-Type-Options', 'nosniff');
      headers.set('X-Frame-Options', 'DENY');
      headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
      return new Response(res.body, {
        status: res.status,
        statusText: res.statusText,
        headers,
      });
    };

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

    // POST /api/rooms  -> create a new room, return roomId + per-slot join URLs/tokens
    if (pathname === '/api/rooms' && request.method === 'POST') {
      // The client sends { numPlayers: 2|3|4, slots: Array<{type: 'human'|'ai', aiProfile?: string}> }
      // For MVP we trust the payload (simple game, no auth yet).
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
      const validAiProfiles = ['v1-random', 'v2-heuristic', 'v3-sniper', 'v4-smart'];
      const slotConfigs: Array<{ type: 'human' | 'ai'; aiProfile?: 'v1-random' | 'v2-heuristic' | 'v3-sniper' | 'v4-smart' }> =
        Array.isArray(body.slots) && body.slots.length === numPlayers
          ? body.slots.map((s: unknown) => {
              const obj = typeof s === 'object' && s !== null ? (s as Record<string, unknown>) : {};
              const type = obj.type === 'ai' ? 'ai' : 'human';
              const aiProfile = type === 'ai' && typeof obj.aiProfile === 'string' && validAiProfiles.includes(obj.aiProfile)
                ? (obj.aiProfile as 'v1-random' | 'v2-heuristic' | 'v3-sniper' | 'v4-smart')
                : 'v1-random';
              return type === 'ai' ? { type, aiProfile } : { type };
            })
          : Array.from({ length: numPlayers }, (_, i) => ({ type: i === 0 ? 'human' : 'ai', aiProfile: 'v1-random' as const }));

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
      const roomId = pathname.split('/')[3];
      if (!roomId || roomId.length > 256) {
        return withResponseHeaders(new Response(JSON.stringify({ error: 'Invalid room ID' }), {
          status: 400,
          headers: { 'content-type': 'application/json' },
        }));
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
      const slot = Number(searchParams.get('slot') ?? '-1');
      const token = searchParams.get('token') ?? '';

      // Strict origin validation for WebSocket to prevent CSRF/Cross-Site WebSocket Hijacking
      if (origin !== null && !isAllowedOrigin) {
        return withResponseHeaders(new Response('Forbidden: Invalid Origin', { status: 403 }));
      }

      if (!roomId || roomId.length > 256 || !Number.isInteger(slot) || slot < 0 || slot > 3 || !token) {
        return withResponseHeaders(new Response('Missing or invalid room/slot/token', { status: 400 }));
      }

      const id = env.GAME_ROOM.idFromName(roomId);
      const stub = env.GAME_ROOM.get(id);

      // Forward the upgrade request to the specific DO instance (it will accept the WS)
      const upgradeReq = new Request(request, {
        headers: {
          ...Object.fromEntries(request.headers),
          'x-room-id': roomId,
          'x-slot': String(slot),
          'x-token': token,
        },
      });
      return stub.fetch(upgradeReq);
    }

    // Fallback
    return withResponseHeaders(new Response('Not found. TankWars Online API. See /api/health', { status: 404 }));
  },
} satisfies ExportedHandler<Env>;

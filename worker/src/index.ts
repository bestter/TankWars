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
      /^http:\/\/localhost:\d+$/.test(origin) ||
      /^http:\/\/127\.0\.0\.1:\d+$/.test(origin)
    );
    const allowedOrigin = isAllowedOrigin ? origin : 'https://tankwars.pages.dev';

    // CORS preflight handling (required for cross-origin POST from Vite dev server on :5173 to worker on :8787)
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': allowedOrigin,
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, x-room-id, x-slot, x-token',
          'Access-Control-Max-Age': '86400',
        },
      });
    }

    // Helper to add CORS to all responses
    const withCors = (res: Response): Response => {
      const headers = new Headers(res.headers);
      headers.set('Access-Control-Allow-Origin', allowedOrigin);
      return new Response(res.body, {
        status: res.status,
        statusText: res.statusText,
        headers,
      });
    };

    // Health / version for easy checks during dev
    if (pathname === '/api/health') {
      return withCors(new Response(JSON.stringify({ ok: true, service: 'tankwars-api', time: Date.now() }), {
        headers: { 'content-type': 'application/json' },
      }));
    }

    // POST /api/rooms  -> create a new room, return roomId + per-slot join URLs/tokens
    if (pathname === '/api/rooms' && request.method === 'POST') {
      // The client sends { numPlayers: 2|3|4, slots: Array<{type: 'human'|'ai', aiProfile?: string}> }
      // For MVP we trust the payload (simple game, no auth yet).
      let body: Record<string, unknown> = {};
      try {
        body = (await request.json()) as Record<string, unknown>;
      } catch {
        body = {};
      }

      const numPlayers = Math.max(2, Math.min(4, Number(body.numPlayers) || 2));
      const slotConfigs: Array<{ type: 'human' | 'ai'; aiProfile?: 'v1-random' | 'v2-heuristic' | 'v3-sniper' | 'v4-smart' }> =
        Array.isArray(body.slots) && body.slots.length === numPlayers
          ? body.slots
          : Array.from({ length: numPlayers }, (_, i) => ({ type: i === 0 ? 'human' : 'ai', aiProfile: 'v1-random' as const }));

      // Create a short room code (human friendly). Real token/secret is generated inside the DO.
      const roomId = crypto.randomUUID().slice(0, 8); // 8 char short id for URLs

      // Get (or create) the DO instance for this roomId
      const id = env.GAME_ROOM.idFromName(roomId);
      const stub = env.GAME_ROOM.get(id);

      // Delegate creation to the DO (it will store the config + generate per-slot secrets)
      const createResp = await stub.fetch('https://internal/create', {
        method: 'POST',
        body: JSON.stringify({ roomId, numPlayers, slotConfigs, origin: allowedOrigin }),
        headers: { 'content-type': 'application/json' },
      });

      if (!createResp.ok) {
        return withCors(new Response(await createResp.text(), { status: 500 }));
      }

      const data = await createResp.json();
      return withCors(new Response(JSON.stringify(data), {
        headers: { 'content-type': 'application/json' },
      }));
    }

    // POST /api/rooms/:roomId/join (optional REST fallback; primary join is via WS)
    if (pathname.startsWith('/api/rooms/') && pathname.endsWith('/join') && request.method === 'POST') {
      const roomId = pathname.split('/')[3];
      const id = env.GAME_ROOM.idFromName(roomId);
      const stub = env.GAME_ROOM.get(id);
      const joinResp = await stub.fetch(request);
      return withCors(new Response(await joinResp.text(), {
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

      if (!roomId || Number.isNaN(slot) || slot < 0 || slot > 3 || !token) {
        return new Response('Missing or invalid room/slot/token', { status: 400 });
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
    return withCors(new Response('Not found. TankWars Online API. See /api/health', { status: 404 }));
  },
} satisfies ExportedHandler<Env>;

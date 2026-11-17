import { DurableObject } from 'cloudflare:workers';

export const RATE_LIMIT_WINDOW_MS = 60_000;
export const RATE_LIMIT_MAX_REQUESTS = 5;
export const RATE_LIMIT_IDLE_MS = 24 * 60 * 60 * 1000;
export const WEBSOCKET_RATE_LIMIT_WINDOW_MS = 10_000;
export const WEBSOCKET_RATE_LIMIT_MAX_REQUESTS = 48;
export const ROOM_RATE_LIMIT_PATH = '/internal/rate-limit';
export const WEBSOCKET_RATE_LIMIT_PATH = '/internal/rate-limit/websocket';

const STORAGE_KEY = 'rate_limit_state';

interface RateLimitState {
  requests: number[];
  lastRequestAt: number;
}

/** One persistent sliding window per IP and traffic class, isolated from game room state. */
export class RateLimiter extends DurableObject {
  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    const websocket = path === WEBSOCKET_RATE_LIMIT_PATH;
    if (!websocket && path !== ROOM_RATE_LIMIT_PATH) {
      return new Response('Not found', { status: 404 });
    }
    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405, headers: { Allow: 'POST' } });
    }

    const windowMs = websocket ? WEBSOCKET_RATE_LIMIT_WINDOW_MS : RATE_LIMIT_WINDOW_MS;
    const maxRequests = websocket ? WEBSOCKET_RATE_LIMIT_MAX_REQUESTS : RATE_LIMIT_MAX_REQUESTS;
    // Keep the decision and persistence atomic, including concurrent requests.
    const retryAfter = await this.ctx.storage.transaction(async (txn) => {
      const now = Date.now();
      const state = await txn.get<RateLimitState>(STORAGE_KEY);
      const requests = (state?.requests ?? []).filter(time => now - time < windowMs);
      const retry = requests.length >= maxRequests
        ? Math.max(1, Math.ceil((requests[0] + windowMs - now) / 1000))
        : 0;
      if (retry === 0) requests.push(now);
      // Rejected attempts count as activity, but do not extend the sliding window.
      await txn.put(STORAGE_KEY, { requests, lastRequestAt: now });
      await txn.setAlarm(now + RATE_LIMIT_IDLE_MS);
      return retry;
    });

    return retryAfter > 0
      ? new Response('Too Many Requests', { status: 429, headers: { 'Retry-After': String(retryAfter) } })
      : new Response(null, { status: 204 });
  }

  async alarm(): Promise<void> {
    await this.ctx.storage.transaction(async (txn) => {
      const state = await txn.get<RateLimitState>(STORAGE_KEY);
      if (state && Date.now() < state.lastRequestAt + RATE_LIMIT_IDLE_MS) {
        // An older alarm/retry must not erase activity received in the meantime.
        await txn.setAlarm(state.lastRequestAt + RATE_LIMIT_IDLE_MS);
        return;
      }
      await txn.delete(STORAGE_KEY);
    });
  }
}

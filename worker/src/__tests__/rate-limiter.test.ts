import { afterEach, describe, expect, it, vi } from 'vitest';
import worker, { type Env, RateLimiter } from '../index';
import { RATE_LIMIT_IDLE_MS, RATE_LIMIT_WINDOW_MS } from '../rate-limiter';

function createLimiter() {
  const data = new Map<string, unknown>();
  const storage = {
    get: vi.fn(async (key: string) => structuredClone(data.get(key))),
    put: vi.fn(async (key: string, value: unknown) => { data.set(key, structuredClone(value)); }),
    delete: vi.fn(async (key: string) => data.delete(key)),
    setAlarm: vi.fn(async (_time: number) => {}),
    transaction: vi.fn(async <T>(callback: (txn: DurableObjectTransaction) => Promise<T>) =>
      callback(storage as unknown as DurableObjectTransaction)),
  };
  const ctx = { storage } as unknown as DurableObjectState;
  const limiter = new RateLimiter(ctx, {});
  // The existing Node test double for cloudflare:workers has no base constructor.
  Reflect.set(limiter, 'ctx', ctx);
  return { limiter, storage, data, ctx };
}

function createEnv() {
  const limiters = new Map<string, ReturnType<typeof createLimiter>>();
  const roomFetch = vi.fn(async () => Response.json({ ok: true, roomId: 'room-id' }));
  const limiterFetch = vi.fn(async (name: string, input: string, init: RequestInit) => {
    let setup = limiters.get(name);
    if (!setup) {
      setup = createLimiter();
      limiters.set(name, setup);
    }
    return setup.limiter.fetch(new Request(input, init));
  });
  const env: Env = {
    GAME_ROOM: {
      idFromName: vi.fn((name: string) => name),
      get: vi.fn(() => ({ fetch: roomFetch })),
    } as unknown as DurableObjectNamespace,
    RATE_LIMITER: {
      idFromName: vi.fn((name: string) => name),
      get: vi.fn((name: string) => ({ fetch: (input: string, init: RequestInit) => limiterFetch(name, input, init) })),
    } as unknown as DurableObjectNamespace,
  };
  const createRoom = (ip?: string) => worker.fetch(new Request('https://api.example/api/rooms', {
    method: 'POST',
    headers: ip ? { 'cf-connecting-ip': ip } : {},
    body: JSON.stringify({ numPlayers: 2 }),
  }), env);
  return { env, createRoom, limiterFetch, roomFetch, limiters };
}

afterEach(() => { vi.restoreAllMocks(); });

describe('Room creation rate limiting', () => {
  it('returns 429 and Retry-After for the sixth request without creating another room', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    const { createRoom, roomFetch } = createEnv();
    for (let i = 0; i < 5; i++) expect((await createRoom('192.0.2.1')).status).toBe(200);
    const response = await createRoom('192.0.2.1');
    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('60');
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://tankwars.pages.dev');
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(roomFetch).toHaveBeenCalledTimes(5);
  });

  it('keeps different IPs independent', async () => {
    const { createRoom } = createEnv();
    for (let i = 0; i < 5; i++) await createRoom('192.0.2.1');
    expect((await createRoom('192.0.2.1')).status).toBe(429);
    expect((await createRoom('192.0.2.2')).status).toBe(200);
  });

  it('uses a shared unknown bucket when cf-connecting-ip is absent', async () => {
    const { createRoom, limiters } = createEnv();
    for (let i = 0; i < 5; i++) expect((await createRoom()).status).toBe(200);
    expect((await createRoom()).status).toBe(429);
    expect(limiters.has('unknown')).toBe(true);
    expect((await createRoom('192.0.2.1')).status).toBe(200);
  });

  it.each([200, 403, 500, 429])('logs and fails open on unexpected status %s or malformed denial', async (status) => {
    const { createRoom, limiterFetch, roomFetch } = createEnv();
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    limiterFetch.mockResolvedValueOnce(new Response('unexpected', { status }));
    expect((await createRoom('192.0.2.1')).status).toBe(200);
    expect(log).toHaveBeenCalledOnce();
    expect(roomFetch).toHaveBeenCalledOnce();
  });

  it('logs and fails open on a limiter exception', async () => {
    const { createRoom, limiterFetch } = createEnv();
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    limiterFetch.mockRejectedValueOnce(new Error('storage unavailable'));
    expect((await createRoom()).status).toBe(200);
    expect(log).toHaveBeenCalledOnce();
  });

  it('rejects invalid origins before accessing either namespace', async () => {
    const { env, limiterFetch, roomFetch } = createEnv();
    const response = await worker.fetch(new Request('https://api.example/api/rooms', {
      method: 'POST', headers: { Origin: 'https://untrusted.example' },
    }), env);
    expect(response.status).toBe(403);
    expect(limiterFetch).not.toHaveBeenCalled();
    expect(roomFetch).not.toHaveBeenCalled();
  });
});

describe('RateLimiter Durable Object', () => {
  const check = (limiter: RateLimiter) => limiter.fetch(new Request('https://internal/internal/rate-limit', { method: 'POST' }));

  it('restricts the internal route and method without changing storage', async () => {
    const { limiter, data } = createLimiter();
    expect((await limiter.fetch(new Request('https://internal/other', { method: 'POST' }))).status).toBe(404);
    const response = await limiter.fetch(new Request('https://internal/internal/rate-limit'));
    expect(response.status).toBe(405);
    expect(response.headers.get('Allow')).toBe('POST');
    expect(data.size).toBe(0);
    expect((await check(limiter)).status).toBe(204);
  });

  it('expires each accepted request at exactly 60 seconds and computes Retry-After', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    const { limiter } = createLimiter();
    await check(limiter);
    now.mockReturnValue(1_010_000);
    for (let i = 0; i < 4; i++) await check(limiter);
    now.mockReturnValue(1_059_999);
    expect((await check(limiter)).headers.get('Retry-After')).toBe('1');
    now.mockReturnValue(1_000_000 + RATE_LIMIT_WINDOW_MS);
    expect((await check(limiter)).status).toBe(204);
    expect((await check(limiter)).headers.get('Retry-After')).toBe('10');
  });

  it('preserves the window when the object is recreated from storage', async () => {
    const { limiter, ctx } = createLimiter();
    for (let i = 0; i < 5; i++) await check(limiter);
    const restored = new RateLimiter(ctx, {});
    Reflect.set(restored, 'ctx', ctx);
    expect((await check(restored)).status).toBe(429);
  });

  it('purges storage after 24 hours of inactivity, including rejected attempts', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    const { limiter, storage, data } = createLimiter();
    for (let i = 0; i < 5; i++) await check(limiter);
    now.mockReturnValue(1_010_000);
    expect((await check(limiter)).status).toBe(429);
    expect(storage.setAlarm).toHaveBeenLastCalledWith(1_010_000 + RATE_LIMIT_IDLE_MS);
    now.mockReturnValue(1_000_000 + RATE_LIMIT_IDLE_MS);
    await limiter.alarm();
    expect(data.size).toBe(1);
    expect(storage.setAlarm).toHaveBeenLastCalledWith(1_010_000 + RATE_LIMIT_IDLE_MS);
    now.mockReturnValue(1_010_000 + RATE_LIMIT_IDLE_MS);
    await limiter.alarm();
    expect(data.size).toBe(0);
    await limiter.alarm();
    expect((await check(limiter)).status).toBe(204);
  });
});

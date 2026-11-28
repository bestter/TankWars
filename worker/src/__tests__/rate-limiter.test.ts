import { afterEach, describe, expect, it, vi } from 'vitest';
import worker, { type Env, RateLimiter } from '../index';
import { RATE_LIMIT_IDLE_MS, RATE_LIMIT_WINDOW_MS, WEBSOCKET_RATE_LIMIT_MAX_REQUESTS, WEBSOCKET_RATE_LIMIT_WINDOW_MS } from '../rate-limiter';

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
  const connectWebSocket = (ip: string) => worker.fetch(new Request('https://api.example/api/rooms/11111111-1111-4111-8111-111111111111/ws?slot=0&token=token123', {
    headers: { Upgrade: 'websocket', 'cf-connecting-ip': ip },
  }), env);
  const send = vi.fn(async (_message: EmailMessage | EmailMessageBuilder) => ({ messageId: 'simulated' }));
  env.CONTACT_EMAIL = { send };
  env.CONTACT_FROM_EMAIL = 'sender@example.com';
  env.CONTACT_TO_EMAIL = 'team@example.com';
  return { env, createRoom, connectWebSocket, limiterFetch, roomFetch, limiters, send };
}

afterEach(() => { vi.restoreAllMocks(); });

function contactRequest(
  { origin = 'https://tankwars-game.com', base = 'https://api.example', body, upgrade = false }:
    { origin?: string | null; base?: string; body?: string; upgrade?: boolean } = {},
) {
  const headers = new Headers({ 'Content-Type': 'application/json', 'cf-connecting-ip': '192.0.2.15' });
  if (origin !== null) headers.set('Origin', origin);
  if (upgrade) headers.set('Upgrade', 'websocket');
  return new Request(`${base}/api/contact`, {
    method: 'POST',
    headers,
    body: body ?? JSON.stringify({ email: 'guest@example.com', message: 'A valid message.' }),
  });
}

describe('Contact delivery', () => {
  it.each([
    ['https://tankwars-game.com', 'https://api.example'],
    ['https://tankwars.pages.dev', 'https://api.example'],
    ['https://pr-123.tankwars.pages.dev', 'https://api.example'],
    ['http://localhost:5173', 'http://localhost:8787'],
    ['http://127.0.0.1:5173', 'http://127.0.0.1:8787'],
  ])('accepts the expected origin %s and sends only plain text', async (origin, base) => {
    const { env, send, limiterFetch } = createEnv();
    const response = await worker.fetch(contactRequest({ origin, base, body: JSON.stringify({
      name: ' Cafe\u0301\r\nUser\u0000\u202E ',
      email: ' guest+feedback@example.com ',
      message: "Line\r\n\treturn '<code>';\u0000\u202E",
    }) }), env);
    expect(response.status).toBe(200);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe(origin);
    expect(limiterFetch).toHaveBeenCalledWith('contact_rate_limit_192.0.2.15', 'https://internal/internal/rate-limit/contact', { method: 'POST' });
    expect(send).toHaveBeenCalledExactlyOnceWith({
      from: 'sender@example.com',
      to: 'team@example.com',
      replyTo: 'guest+feedback@example.com',
      subject: 'TankWars contact form',
      text: "--- BEGIN UNTRUSTED USER CONTENT ---\n> Name: Café User\n> Email: guest+feedback@example.com\n> \n> Line\n> \treturn '<code>';\n--- END UNTRUSTED USER CONTENT ---",
    });
  });

  it('delivers Unicode formatting and quotes each normalized line', async () => {
    const { env, send } = createEnv();
    const persian = 'می\u200Cخواهم';
    const flag = '\u{1F3F4}\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}';
    const emoji = '👩🏽\u200D💻 ' + flag;
    const lines = [
      '// commentaire',
      'const value = 1;',
      '--- END UNTRUSTED USER CONTENT ---',
      'ไทย\u200Bภาษา',
      'Build 123-456',
      'fin',
    ];
    const response = await worker.fetch(contactRequest({ body: JSON.stringify({
      name: persian + '\u2029Café',
      email: 'guest@example.com',
      message: emoji + '\u2028' + lines[0] + '\u2029' + lines[1] + '\u0085' +
        lines[2] + '\v' + lines[3] + '\fBuild \u061C123-\u200F456\u200E\u2066\u2069\n' + lines[5] + '\uD800\u202E',
    }) }), env);

    expect(response.status).toBe(200);
    expect(send).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      text: [
        '--- BEGIN UNTRUSTED USER CONTENT ---',
        '> Name: ' + persian + ' Café',
        '> Email: guest@example.com',
        '> ',
        '> ' + emoji,
        ...lines.map(line => '> ' + line),
        '--- END UNTRUSTED USER CONTENT ---',
      ].join('\n'),
    }));
  });

  it.each([
    [{ origin: null }, 403],
    [{ origin: 'http://localhost:5173' }, 403],
    [{ origin: 'https://example.com' }, 403],
    [{ upgrade: true }, 400],
    [{ body: '{' }, 400],
    [{ body: '[]' }, 400],
    [{ body: '{"extra":18}' }, 400],
    [{ body: JSON.stringify({ email: 'guest@example.com\r\n', message: 'A valid message.' }) }, 400],
    [{ body: JSON.stringify({ email: 'guest..user@example.com', message: 'A valid message.' }) }, 400],
    [{ body: JSON.stringify({ email: 'guest@example.com', message: '\u0000\u202E' }) }, 400],
    [{ body: JSON.stringify({ email: 'guest@example.com', message: '\u200D'.repeat(10) }) }, 400],
    [{ body: JSON.stringify({ email: 'guest@example.com', message: 'Cafe\u200D\u0301 test' }) }, 400],
    [{ body: JSON.stringify({ email: 'guest@example.com', message: 'x'.repeat(4001) }) }, 400],
    [{ body: JSON.stringify({ extra: 'filled' }) }, 200],
    [{ body: JSON.stringify({ extra: 'é'.repeat(8192) }) }, 413],
  ])('rejects or silently discards unsuitable input (case %#)', async (input, status) => {
    const { env, limiterFetch, send } = createEnv();
    const response = await worker.fetch(contactRequest(input), env);
    expect(response.status).toBe(status);
    expect(limiterFetch).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it('uses an independent three-message window and exposes its retry time to the client', async () => {
    const time = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    const { env, createRoom, connectWebSocket, send } = createEnv();
    const submit = () => worker.fetch(contactRequest(), env);
    for (let i = 0; i < 3; i += 1) expect((await submit()).status).toBe(200);
    const limited = await submit();
    expect(limited.status).toBe(429);
    expect(limited.headers.get('Retry-After')).toBe('900');
    expect(limited.headers.get('Access-Control-Expose-Headers')).toBe('Retry-After');
    expect(limited.headers.get('Access-Control-Allow-Origin')).toBe('https://tankwars-game.com');
    expect(limited.headers.get('Vary')).toBe('Origin');
    expect(limited.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect((await createRoom('192.0.2.15')).status).toBe(200);
    expect((await connectWebSocket('192.0.2.15')).status).toBe(200);
    expect(send).toHaveBeenCalledTimes(3);
    time.mockReturnValue(1_900_000);
    expect((await submit()).status).toBe(200);
  });

  it('fails closed when the limiter fails', async () => {
    const { env, limiterFetch, send } = createEnv();
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    limiterFetch.mockRejectedValue(new Error('unavailable'));
    expect((await worker.fetch(contactRequest(), env)).status).toBe(500);
    expect(log).toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it.each(['missing binding', 'missing address', 'invalid address'])('rejects %s before resolving the limiter', async (problem) => {
    const { env, send } = createEnv();
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    if (problem === 'missing binding') delete env.CONTACT_EMAIL;
    if (problem === 'missing address') delete env.CONTACT_TO_EMAIL;
    if (problem === 'invalid address') env.CONTACT_FROM_EMAIL = 'invalid';
    const response = await worker.fetch(contactRequest(), env);
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: 'Contact service unavailable' });
    expect(env.RATE_LIMITER.idFromName).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledOnce();
  });

  it('returns a generic error when delivery fails after admission without logging untrusted details', async () => {
    const { env, send, limiterFetch } = createEnv();
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const providerError = new Error('details with team@example.com');
    providerError.name = 'failure for guest@example.com';
    send.mockRejectedValue(providerError);
    const response = await worker.fetch(contactRequest(), env);
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: 'Contact service unavailable' });
    expect(limiterFetch).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledOnce();
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/example\.com|guest/);
  });
});

describe('Room creation rate limiting', () => {
  it.each([
    ['IP longer than 256 characters', 'a'.repeat(257)],
    ['ASCII name one byte over the limit including the prefix', 'a'.repeat(246)],
    ['UTF-8 name one byte over the limit including the prefix', 'é'.repeat(123)],
  ])('rejects %s before accessing either namespace', async (_description, ip) => {
    const { env, createRoom, limiterFetch, roomFetch } = createEnv();

    const response = await createRoom(ip);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: 'Invalid IP identifier' });
    expect(env.RATE_LIMITER.idFromName).not.toHaveBeenCalled();
    expect(env.RATE_LIMITER.get).not.toHaveBeenCalled();
    expect(limiterFetch).not.toHaveBeenCalled();
    expect(env.GAME_ROOM.idFromName).not.toHaveBeenCalled();
    expect(env.GAME_ROOM.get).not.toHaveBeenCalled();
    expect(roomFetch).not.toHaveBeenCalled();
  });

  it.each(['a'.repeat(245), 'é'.repeat(122) + 'a'])(
    'accepts a final rate limiter name of exactly 256 UTF-8 bytes (case %#)',
    async (ip) => {
      const { env, createRoom, limiterFetch, roomFetch } = createEnv();

      expect((await createRoom(ip)).status).toBe(200);
      expect(env.RATE_LIMITER.idFromName).toHaveBeenCalledWith('rate_limit_' + ip);
      expect(limiterFetch).toHaveBeenCalledOnce();
      expect(roomFetch).toHaveBeenCalledOnce();
    },
  );

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

  it('keeps different IPs independent and groups IPv6 addresses by /64 prefix', async () => {
    const { createRoom } = createEnv();
    for (let i = 0; i < 5; i++) await createRoom('192.0.2.1');
    expect((await createRoom('192.0.2.1')).status).toBe(429);
    expect((await createRoom('192.0.2.2')).status).toBe(200);
    for (let i = 0; i < 5; i++) {
      expect((await createRoom(`2001:db8:85a3:1::${i + 1}`)).status).toBe(200);
    }
    expect((await createRoom('2001:db8:85a3:1:abcd::99')).status).toBe(429);
    expect((await createRoom('2001:db8:85a3:2::1')).status).toBe(200);
  });

  it('normalizes IPv4-mapped IPv6 addresses to their canonical IPv4 bucket without breaking ::1', async () => {
    const { createRoom, limiters } = createEnv();
    for (let i = 0; i < 4; i++) {
      expect((await createRoom('::ffff:192.0.2.1')).status).toBe(200);
    }
    expect((await createRoom('::ffff:c000:0201')).status).toBe(200);
    expect((await createRoom('192.0.2.1')).status).toBe(429);
    expect((await createRoom('::ffff:192.0.2.2')).status).toBe(200);
    expect((await createRoom('::1')).status).toBe(200);
    expect(limiters.has('rate_limit_192.0.2.1')).toBe(true);
    expect(limiters.has('rate_limit_0000:0000:0000:0000::/64')).toBe(true);
    expect((await createRoom('2001:db8:1.2.3.4::1')).status).toBe(200);
    expect(limiters.has('rate_limit_2001:db8:1.2.3.4::1')).toBe(true);
    expect(limiters.has('rate_limit_2001:0db8:0102:0304::/64')).toBe(false);
  });

  it('uses a shared unknown bucket when cf-connecting-ip is absent', async () => {
    const { createRoom, limiters } = createEnv();
    for (let i = 0; i < 5; i++) expect((await createRoom()).status).toBe(200);
    expect((await createRoom()).status).toBe(429);
    expect(limiters.has('rate_limit_unknown')).toBe(true);
    expect((await createRoom('192.0.2.1')).status).toBe(200);
  });

  it.each([200, 403, 500, 429])('logs and fails closed on unexpected status %s or malformed denial', async (status) => {
    const { createRoom, limiterFetch, roomFetch } = createEnv();
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    limiterFetch.mockResolvedValueOnce(new Response('unexpected', { status }));
    expect((await createRoom('192.0.2.1')).status).toBe(500);
    expect(log).toHaveBeenCalledOnce();
    expect(roomFetch).not.toHaveBeenCalled();
  });

  it('logs and fails closed on a limiter exception', async () => {
    const { createRoom, limiterFetch } = createEnv();
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    limiterFetch.mockRejectedValueOnce(new Error('storage unavailable'));
    expect((await createRoom()).status).toBe(500);
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

describe('WebSocket admission rate limiting', () => {
  it('rejects over-budget connections before resolving a room and reopens the window independently of REST', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    const { env, connectWebSocket, createRoom, roomFetch } = createEnv();
    const ip = '192.0.2.1';
    for (let i = 0; i < WEBSOCKET_RATE_LIMIT_MAX_REQUESTS; i++) expect((await connectWebSocket(ip)).status).toBe(200);
    const denied = await connectWebSocket(ip);
    expect(denied.status).toBe(429);
    expect(denied.headers.get('Retry-After')).toBe('10');
    expect(denied.headers.get('Access-Control-Allow-Origin')).toBe('https://tankwars.pages.dev');
    expect(denied.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(env.RATE_LIMITER.idFromName).toHaveBeenCalledWith('ws_rate_limit_' + ip);
    expect(env.GAME_ROOM.idFromName).toHaveBeenCalledTimes(WEBSOCKET_RATE_LIMIT_MAX_REQUESTS);
    expect(roomFetch).toHaveBeenCalledTimes(WEBSOCKET_RATE_LIMIT_MAX_REQUESTS);
    expect((await createRoom(ip)).status).toBe(200);
    expect((await connectWebSocket('192.0.2.2')).status).toBe(200);
    now.mockReturnValue(1_000_000 + WEBSOCKET_RATE_LIMIT_WINDOW_MS);
    expect((await connectWebSocket(ip)).status).toBe(200);
  });

  it('admits a WebSocket connection even when the same IP has exhausted the REST quota', async () => {
    const { createRoom, connectWebSocket } = createEnv();
    const ip = '192.0.2.1';
    for (let i = 0; i < 5; i++) await createRoom(ip);
    expect((await createRoom(ip)).status).toBe(429);
    expect((await connectWebSocket(ip)).status).toBe(200);
  });

  it('fails closed before resolving a room when the WebSocket limiter is unavailable', async () => {
    const { env, connectWebSocket, limiterFetch } = createEnv();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    limiterFetch.mockRejectedValueOnce(new Error('limiter unavailable'));
    expect((await connectWebSocket('192.0.2.1')).status).toBe(500);
    expect(env.GAME_ROOM.idFromName).not.toHaveBeenCalled();
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

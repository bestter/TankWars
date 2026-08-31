import { describe, it, expect, vi } from 'vitest';
import worker, { type Env } from '../index';

describe('Worker Entrypoint', () => {
  const expectSecurityHeaders = (response: Response): void => {
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(response.headers.get('X-Frame-Options')).toBe('DENY');
    expect(response.headers.get('Strict-Transport-Security')).toBe('max-age=31536000; includeSubDomains');
  };

  const createMockEnv = () => {
    const mockStub = {
      fetch: vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 })),
    };
    const mockNamespace = {
      idFromName: vi.fn().mockReturnValue({ toString: () => 'mock-id' }),
      get: vi.fn().mockReturnValue(mockStub),
    } as unknown as DurableObjectNamespace;

    const env: Env = {
      GAME_ROOM: mockNamespace,
    };

    return { env, mockStub, mockNamespace };
  };

  describe('/api/health', () => {
    it('returns ok status', async () => {
      const { env } = createMockEnv();
      const request = new Request('https://tankwars.pages.dev/api/health');
      const response = await worker.fetch(request, env);

      expect(response.status).toBe(200);
      const data = (await response.json()) as {
        ok: boolean;
        service: string;
        protocolVersion: number;
        minimumClientProtocolVersion: number;
      };
      expect(data.ok).toBe(true);
      expect(data.service).toBe('tankwars-api');
      expect(data.protocolVersion).toBe(1);
      expect(data.minimumClientProtocolVersion).toBe(0);
      expectSecurityHeaders(response);
    });
  });

  describe('CORS preflight', () => {
    it('adds CORS and security headers', async () => {
      const { env } = createMockEnv();
      const request = new Request('https://tankwars.pages.dev/api/rooms', {
        method: 'OPTIONS',
        headers: { Origin: 'http://localhost:5173' },
      });
      const response = await worker.fetch(request, env);

      expect(response.status).toBe(204);
      expect(response.headers.get('Access-Control-Allow-Origin')).toBe('http://localhost:5173');
      expect(response.headers.get('Access-Control-Allow-Methods')).toBe('GET, POST, OPTIONS');
      expectSecurityHeaders(response);
    });
  });

  describe('/api/rooms', () => {
    it('normalizes missing or unknown AI profiles to v2-heuristic', async () => {
      const { env, mockStub } = createMockEnv();
      const request = new Request('https://tankwars.pages.dev/api/rooms', {
        method: 'POST',
        headers: {
          Origin: 'https://tankwars.pages.dev',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          numPlayers: 3,
          slots: [
            { type: 'human' },
            { type: 'ai' },
            { type: 'ai', aiProfile: 'future-profile' },
          ],
        }),
      });

      const response = await worker.fetch(request, env);

      expect(response.status).toBe(200);
      const forwardedInit = mockStub.fetch.mock.calls[0]?.[1] as RequestInit;
      const forwardedBody = JSON.parse(String(forwardedInit.body)) as {
        slotConfigs: Array<{ type: string; aiProfile?: string }>;
      };
      expect(forwardedBody.slotConfigs).toEqual([
        { type: 'human' },
        { type: 'ai', aiProfile: 'v2-heuristic' },
        { type: 'ai', aiProfile: 'v2-heuristic' },
      ]);
    });
  });

  describe('/api/rooms/:roomId/join', () => {
    it('rejects roomId longer than 256 characters', async () => {
      const { env, mockNamespace } = createMockEnv();
      const longRoomId = 'a'.repeat(257);
      const request = new Request(`https://tankwars.pages.dev/api/rooms/${longRoomId}/join`, {
        method: 'POST',
      });
      const response = await worker.fetch(request, env);

      expect(response.status).toBe(400);
      const data = (await response.json()) as { error: string };
      expect(data.error).toBe('Invalid room ID');
      expect(mockNamespace.idFromName).not.toHaveBeenCalled();
    });

    it('accepts valid roomId of 256 chars or less', async () => {
      const { env, mockNamespace } = createMockEnv();
      const validRoomId = 'a'.repeat(256);
      const request = new Request(`https://tankwars.pages.dev/api/rooms/${validRoomId}/join`, {
        method: 'POST',
      });
      const response = await worker.fetch(request, env);

      expect(response.status).toBe(200);
      expect(mockNamespace.idFromName).toHaveBeenCalledWith(validRoomId);
    });
  });

  describe('/api/rooms/:roomId/ws', () => {
    it('accepts upgrade without Origin header (non-browser client)', async () => {
      const { env, mockStub } = createMockEnv();
      const request = new Request('http://localhost/api/rooms/room1/ws?slot=0&token=123');
      const response = await worker.fetch(request, env);
      expect(response.status).toBe(200);
      expect(mockStub.fetch).toHaveBeenCalled();
    });

    it('accepts upgrade with allowed Origin header', async () => {
      const { env, mockStub } = createMockEnv();
      const request = new Request('http://localhost/api/rooms/room1/ws?slot=0&token=123', {
        headers: { Origin: 'https://tankwars.pages.dev' },
      });
      const response = await worker.fetch(request, env);
      expect(response.status).toBe(200);
      expect(mockStub.fetch).toHaveBeenCalled();
    });

    it('accepts upgrade with valid subdomain Origin header', async () => {
      const { env, mockStub } = createMockEnv();
      const request = new Request('http://localhost/api/rooms/room1/ws?slot=0&token=123', {
        headers: { Origin: 'https://pr-123.tankwars.pages.dev' },
      });
      const response = await worker.fetch(request, env);
      expect(response.status).toBe(200);
      expect(mockStub.fetch).toHaveBeenCalled();
    });

    it('rejects upgrade with disallowed Origin header', async () => {
      const { env } = createMockEnv();
      const request = new Request('http://localhost/api/rooms/room1/ws?slot=0&token=123', {
        headers: { Origin: 'https://malicious-site.com' },
      });
      const response = await worker.fetch(request, env);
      expect(response.status).toBe(403);
      expect(await response.text()).toBe('Forbidden: Invalid Origin');
      expectSecurityHeaders(response);
    });

    it('rejects upgrade with missing token', async () => {
      const { env } = createMockEnv();
      const request = new Request('http://localhost/api/rooms/room1/ws?slot=0', {
        headers: { Origin: 'https://tankwars.pages.dev' },
      });
      const response = await worker.fetch(request, env);
      expect(response.status).toBe(400);
      expectSecurityHeaders(response);
    });

    it('rejects WebSocket upgrade with roomId longer than 256 characters', async () => {
      const { env, mockNamespace } = createMockEnv();
      const longRoomId = 'b'.repeat(257);
      const request = new Request(`https://tankwars.pages.dev/api/rooms/${longRoomId}/ws?slot=0&token=secret-token`);
      const response = await worker.fetch(request, env);

      expect(response.status).toBe(400);
      const text = await response.text();
      expect(text).toBe('Missing or invalid room/slot/token');
      expect(mockNamespace.idFromName).not.toHaveBeenCalled();
    });

    it('forwards WebSocket upgrade with valid parameters', async () => {
      const { env, mockNamespace, mockStub } = createMockEnv();
      const validRoomId = 'test-room-123';
      const request = new Request(`https://tankwars.pages.dev/api/rooms/${validRoomId}/ws?slot=1&token=token123`);
      const response = await worker.fetch(request, env);

      expect(response.status).toBe(200);
      expect(mockNamespace.idFromName).toHaveBeenCalledWith(validRoomId);
      expect(mockStub.fetch).toHaveBeenCalled();
    });
  });
});

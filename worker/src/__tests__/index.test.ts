import { describe, it, expect, vi } from 'vitest';
import worker from '../index';
import { GameRoom } from '../game-room';

// Mock Durable Object Namespace
const mockGameRoomDO = {
  idFromName: vi.fn().mockReturnValue('mock-id'),
  get: vi.fn().mockReturnValue({
    fetch: vi.fn().mockResolvedValue(new Response('Mock Upgrade')),
  }),
};

const env = {
  GAME_ROOM: mockGameRoomDO as any,
};

describe('Worker Entrypoint', () => {
  describe('WebSocket Upgrade Route /api/rooms/:roomId/ws', () => {
    it('accepts upgrade without Origin header (non-browser client)', async () => {
      const request = new Request('http://localhost/api/rooms/room1/ws?slot=0&token=123');
      const response = await worker.fetch(request, env);
      expect(response.status).toBe(200);
    });

    it('accepts upgrade with allowed Origin header', async () => {
      const request = new Request('http://localhost/api/rooms/room1/ws?slot=0&token=123', {
        headers: { Origin: 'https://tankwars.pages.dev' },
      });
      const response = await worker.fetch(request, env);
      expect(response.status).toBe(200);
    });

    it('accepts upgrade with valid subdomain Origin header', async () => {
      const request = new Request('http://localhost/api/rooms/room1/ws?slot=0&token=123', {
        headers: { Origin: 'https://pr-123.tankwars.pages.dev' },
      });
      const response = await worker.fetch(request, env);
      expect(response.status).toBe(200);
    });

    it('rejects upgrade with disallowed Origin header', async () => {
      const request = new Request('http://localhost/api/rooms/room1/ws?slot=0&token=123', {
        headers: { Origin: 'https://malicious-site.com' },
      });
      const response = await worker.fetch(request, env);
      expect(response.status).toBe(403);
      expect(await response.text()).toBe('Forbidden: Invalid Origin');
    });

    it('rejects upgrade with missing token', async () => {
      const request = new Request('http://localhost/api/rooms/room1/ws?slot=0', {
        headers: { Origin: 'https://tankwars.pages.dev' },
      });
      const response = await worker.fetch(request, env);
      expect(response.status).toBe(400);
    });
  });
});

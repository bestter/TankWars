import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GameRoom } from '../game-room';

describe('GameRoom', () => {
  let mockCtx: any;
  let room: GameRoom;

  beforeEach(() => {
    mockCtx = {
      blockConcurrencyWhile: vi.fn((cb) => cb()),
      storage: {
        get: vi.fn(),
        put: vi.fn(),
      },
    };
    room = new GameRoom(mockCtx, {});
  });

  describe('handleClientMessage', () => {
    it('should catch JSON parse errors and return without throwing', async () => {
      // It returns undefined gracefully on error
      const result = await (room as any).handleClientMessage(0, 'invalid{json');
      expect(result).toBeUndefined();
    });

    it('should drop oversized string payloads and not crash', async () => {
      const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const oversizedPayload = 'a'.repeat(8193);
      const result = await (room as any).handleClientMessage(0, oversizedPayload);
      expect(result).toBeUndefined();
      expect(consoleWarnSpy).toHaveBeenCalledWith(expect.stringContaining('Dropping oversized payload'));
      consoleWarnSpy.mockRestore();
    });
  });
});

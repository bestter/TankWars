import { describe, it, expect } from 'vitest';
import { apiBaseToWsBase } from '../onlineApi';

describe('onlineApi', () => {
  describe('apiBaseToWsBase', () => {
    it('converts https to wss', () => {
      expect(apiBaseToWsBase('https://tankwars-api.foo.workers.dev')).toBe(
        'wss://tankwars-api.foo.workers.dev',
      );
    });

    it('converts http to ws', () => {
      expect(apiBaseToWsBase('http://localhost:8787')).toBe('ws://localhost:8787');
    });

    it('strips nothing from already-wss URLs', () => {
      expect(apiBaseToWsBase('wss://tankwars-api.foo.workers.dev')).toBe(
        'wss://tankwars-api.foo.workers.dev',
      );
    });
  });
});
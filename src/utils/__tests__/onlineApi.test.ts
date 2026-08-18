import { describe, it, expect } from 'vitest';
import { apiBaseToWsBase, getOnlineApiBase, getOnlineWsBase } from '../onlineApi';

describe('onlineApi', () => {
  describe('dev bases', () => {
    it('returns the local wrangler API and WS bases in DEV', () => {
      expect(getOnlineApiBase()).toBe('http://localhost:8787');
      expect(getOnlineWsBase()).toBe('ws://localhost:8787');
    });
  });

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
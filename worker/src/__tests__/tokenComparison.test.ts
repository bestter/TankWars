import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tokenMatches } from '../tokenComparison';

// Node lacks Cloudflare's extension. Runtime coverage lives in the local smoke test.
describe('tokenMatches', () => {
  const compare = vi.fn((a: Uint8Array, b: Uint8Array) => a.byteLength === b.byteLength && a.every((byte, index) => byte === b[index]));
  beforeEach(() => {
    compare.mockClear();
    vi.stubGlobal('crypto', { subtle: { timingSafeEqual: compare } });
  });
  afterEach(() => vi.unstubAllGlobals());
  it('preserves exact equality, including legacy non-UUID values', () => {
    expect(tokenMatches('synthetic-secret', 'synthetic-secret')).toBe(true);
    expect(tokenMatches('é-token', 'é-token')).toBe(true);
  });
  it.each(['Synthetic-secret', 'synthetic-Secret', 'synthetic-secreT', 'synthetic',
    'synthetic-secret-long', ' synthétique ', 'éynthetic-secret', ''])('rejects %s using equal byte lengths', value => {
    expect(tokenMatches(value, 'synthetic-secret')).toBe(false);
    expect(compare).toHaveBeenCalledOnce();
    const [left, right] = compare.mock.calls[0];
    expect(left.byteLength).toBe(right.byteLength);
  });
  it.each([undefined, null, '', 42, {}])('fails closed for an invalid stored token %s', value => {
    expect(tokenMatches('synthetic', value)).toBe(false);
  });
  it('fails closed if the runtime primitive is missing', () => {
    vi.stubGlobal('crypto', { subtle: {} });
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(tokenMatches('synthetic', 'synthetic')).toBe(false);
    expect(log).toHaveBeenCalledWith('[GameRoom] Secure token comparison unavailable');
    log.mockRestore();
  });
});

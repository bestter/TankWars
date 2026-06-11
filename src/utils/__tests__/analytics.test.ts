import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { trackEvent } from '../analytics';

interface MockZaraz {
  track: ReturnType<typeof vi.fn> | (() => void);
}

interface MockGlobal {
  window?: {
    zaraz?: MockZaraz;
  };
}

describe('analytics utility', () => {
  const globalRef = globalThis as unknown as MockGlobal;
  let originalWindow: unknown;

  beforeEach(() => {
    // Sauvegarder
    originalWindow = globalRef.window;
    globalRef.window = {
      zaraz: undefined
    };
  });

  afterEach(() => {
    // Restaurer
    globalRef.window = originalWindow as MockGlobal['window'];
    vi.restoreAllMocks();
  });

  it('should call window.zaraz.track if zaraz is available', () => {
    const trackMock = vi.fn();
    globalRef.window = {
      zaraz: {
        track: trackMock
      }
    };

    const properties = { playerCount: 2, aiCount: 1 };
    trackEvent('test_event', properties);

    expect(trackMock).toHaveBeenCalledTimes(1);
    expect(trackMock).toHaveBeenCalledWith('test_event', properties);
  });

  it('should fall back gracefully and log if zaraz is not available', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    
    expect(() => {
      trackEvent('test_event', { customProp: 'hello' });
    }).not.toThrow();

    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('[Analytics] [Simulated] Tracked event: "test_event"'),
      { customProp: 'hello' }
    );
  });

  it('should catch and log errors if window.zaraz.track throws', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const trackMock = vi.fn().mockImplementation(() => {
      throw new Error('Zaraz network failure');
    });
    
    globalRef.window = {
      zaraz: {
        track: trackMock
      }
    };

    expect(() => {
      trackEvent('test_event', { test: true });
    }).not.toThrow();

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('[Analytics] Failed to track event "test_event" via Zaraz:'),
      "Zaraz network failure"
    );
  });
});

// @vitest-environment jsdom
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

vi.mock('react-dom/client', () => ({
  createRoot: vi.fn(() => ({
    render: vi.fn(),
  })),
}));

vi.mock('react-helmet-async', () => ({
  HelmetProvider: ({ children }: { children: React.ReactNode }) => children,
}));

vi.mock('../App.tsx', () => ({
  default: () => null,
}));

describe('main.tsx', () => {
  const originalEnvProd = import.meta.env.PROD;
  const originalConsoleLog = console.log;
  const originalConsoleInfo = console.info;

  beforeEach(() => {
    document.body.innerHTML = '<div id="root"></div>';
    vi.resetModules();
    (import.meta.env as Record<string, unknown>).PROD = true;

    // Mock navigator.serviceWorker
    Object.defineProperty(navigator, 'serviceWorker', {
      value: {
        register: vi.fn().mockResolvedValue({}),
      },
      writable: true,
      configurable: true,
    });

    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    (import.meta.env as Record<string, unknown>).PROD = originalEnvProd;
    console.log = originalConsoleLog;
    console.info = originalConsoleInfo;
    vi.restoreAllMocks();
  });

  it('handles service worker registration success', async () => {
    await import('../main');

    window.dispatchEvent(new Event('load'));
    await new Promise(process.nextTick);

    expect(navigator.serviceWorker.register).toHaveBeenCalledWith('/sw.js');
  });

  it('handles service worker registration failure', async () => {
    navigator.serviceWorker.register = vi.fn().mockRejectedValue(new Error('Test registration error'));

    await import('../main?bust=1');

    window.dispatchEvent(new Event('load'));
    await new Promise(process.nextTick);

    expect(console.error).toHaveBeenCalledWith(
      "Service Worker registration failed",
      "Test registration error"
    );
  });

  it('handles service worker registration failure with non-Error object', async () => {
    navigator.serviceWorker.register = vi.fn().mockRejectedValue('String error');

    await import('../main?bust=2');

    window.dispatchEvent(new Event('load'));
    await new Promise(process.nextTick);

    expect(console.error).toHaveBeenCalledWith(
      "Service Worker registration failed",
      "String error"
    );
  });

  it('neutralizes console methods in production', async () => {
    await import('../main?bust=3');

    expect(console.log.name).toBe('noop');
    expect(console.info.name).toBe('noop');

    // Verify noop works
    expect(() => console.log('test')).not.toThrow();
  });

  it('does not register service worker or neutralize console if not in PROD', async () => {
    (import.meta.env as Record<string, unknown>).PROD = false;
    vi.mocked(navigator.serviceWorker.register).mockClear();

    // Need to clear out event listeners manually by resetting the whole window
    const oldWindow = global.window;
    type EventCallback = (e: Event) => void;
    const listeners: Record<string, EventCallback[]> = {};
    const newWindow = {
      ...oldWindow,
      addEventListener: (type: string, listener: EventCallback) => {
        if (!listeners[type]) listeners[type] = [];
        listeners[type].push(listener);
      },
      dispatchEvent: (event: Event) => {
        if (listeners[event.type]) {
          listeners[event.type].forEach(l => l(event));
        }
        return true;
      }
    };
    global.window = newWindow as unknown as Window & typeof globalThis;

    await import('../main?bust=4');

    expect(console.log.name).not.toBe('noop');

    global.window.dispatchEvent(new Event('load'));
    await new Promise(process.nextTick);

    expect(navigator.serviceWorker.register).not.toHaveBeenCalled();

    global.window = oldWindow;
  });
});

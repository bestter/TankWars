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
  const neutralizedConsoleMethods = [
    'log',
    'info',
    'warn',
    'debug',
    'trace',
    'group',
    'groupCollapsed',
    'groupEnd',
    'time',
    'timeEnd',
  ] as const;
  const originalConsoleMethods = {
    log: console.log,
    info: console.info,
    warn: console.warn,
    debug: console.debug,
    trace: console.trace,
    group: console.group,
    groupCollapsed: console.groupCollapsed,
    groupEnd: console.groupEnd,
    time: console.time,
    timeEnd: console.timeEnd,
  };
  const originalServiceWorkerDescriptor = Object.getOwnPropertyDescriptor(
    navigator,
    'serviceWorker',
  );
  let loadListener: EventListenerOrEventListenerObject | undefined;

  const dispatchCapturedLoad = async () => {
    expect(loadListener).toBeDefined();

    const loadEvent = new Event('load');
    if (typeof loadListener === 'function') {
      loadListener.call(window, loadEvent);
    } else {
      loadListener?.handleEvent(loadEvent);
    }

    await new Promise<void>((resolve) => process.nextTick(resolve));
  };

  beforeEach(() => {
    document.body.innerHTML = '<div id="root"></div>';
    vi.resetModules();
    (import.meta.env as Record<string, unknown>).PROD = true;
    loadListener = undefined;

    // Mock navigator.serviceWorker
    Object.defineProperty(navigator, 'serviceWorker', {
      value: {
        register: vi.fn().mockResolvedValue({}),
      },
      writable: true,
      configurable: true,
    });

    vi.spyOn(window, 'addEventListener').mockImplementation((type, listener) => {
      if (type === 'load') {
        loadListener = listener;
      }
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    (import.meta.env as Record<string, unknown>).PROD = originalEnvProd;
    Object.assign(console, originalConsoleMethods);
    if (originalServiceWorkerDescriptor) {
      Object.defineProperty(navigator, 'serviceWorker', originalServiceWorkerDescriptor);
    } else {
      Reflect.deleteProperty(navigator, 'serviceWorker');
    }
    loadListener = undefined;
  });

  it('handles service worker registration success', async () => {
    await import('../main');

    expect(window.addEventListener).toHaveBeenCalledTimes(1);
    expect(window.addEventListener).toHaveBeenCalledWith('load', expect.any(Function));

    await dispatchCapturedLoad();

    expect(navigator.serviceWorker.register).toHaveBeenCalledTimes(1);
    expect(navigator.serviceWorker.register).toHaveBeenCalledWith('/sw.js');
  });

  it('handles service worker registration failure', async () => {
    navigator.serviceWorker.register = vi.fn().mockRejectedValue(new Error('Test registration error'));

    await import('../main');

    await dispatchCapturedLoad();

    expect(console.error).toHaveBeenCalledWith(
      "Service Worker registration failed",
      "Test registration error"
    );
  });

  it('handles service worker registration failure with non-Error object', async () => {
    navigator.serviceWorker.register = vi.fn().mockRejectedValue('String error');

    await import('../main');

    await dispatchCapturedLoad();

    expect(console.error).toHaveBeenCalledWith(
      "Service Worker registration failed",
      "String error"
    );
  });

  it('neutralizes console methods in production', async () => {
    await import('../main');

    neutralizedConsoleMethods.forEach((method) => {
      expect(console[method].name).toBe('noop');
    });

    // Verify noop works
    expect(() => console.log('test')).not.toThrow();
  });

  it('does not register service worker or neutralize console if not in PROD', async () => {
    (import.meta.env as Record<string, unknown>).PROD = false;

    await import('../main');

    expect(window.addEventListener).not.toHaveBeenCalled();
    expect(loadListener).toBeUndefined();
    neutralizedConsoleMethods.forEach((method) => {
      expect(console[method]).toBe(originalConsoleMethods[method]);
    });

    expect(navigator.serviceWorker.register).not.toHaveBeenCalled();
  });
});

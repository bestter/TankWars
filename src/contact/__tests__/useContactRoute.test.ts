// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useContactRoute } from '../useContactRoute';

describe('useContactRoute', () => {
  beforeEach(() => {
    vi.stubEnv('DEV', true);
    window.history.replaceState(null, '', '/');
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    window.history.replaceState(null, '', '/');
  });

  it('does not push duplicate history entries when navigating to the already active path and resets navigationFailed', () => {
    const pushStateSpy = vi.spyOn(window.history, 'pushState');
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { result } = renderHook(() => useContactRoute(true, false));

    // Closing from '/' must not call pushState.
    act(() => {
      result.current.closeContact();
    });
    expect(pushStateSpy).not.toHaveBeenCalled();

    // First failed open sets navigationFailed; a second call to closeContact from '/' clears it without pushState.
    pushStateSpy.mockImplementationOnce(() => {
      throw new DOMException('History unavailable', 'SecurityError');
    });
    act(() => {
      result.current.openContact?.();
    });
    expect(errorLog).toHaveBeenCalledOnce();
    expect(result.current.navigationFailed).toBe(true);
    expect(window.location.pathname).toBe('/');

    act(() => {
      result.current.closeContact();
    });
    expect(result.current.navigationFailed).toBe(false);
    expect(pushStateSpy).toHaveBeenCalledTimes(1);

    // Calling openContact twice from '/' only pushes '/contact' once.
    act(() => {
      result.current.openContact?.();
    });
    act(() => {
      result.current.openContact?.();
    });
    expect(window.location.pathname).toBe('/contact');
    expect(result.current.showContact).toBe(true);
    expect(pushStateSpy).toHaveBeenCalledTimes(2);

    // Calling closeContact twice from '/contact' only pushes '/' once.
    act(() => {
      result.current.closeContact();
    });
    act(() => {
      result.current.closeContact();
    });
    expect(window.location.pathname).toBe('/');
    expect(result.current.showContact).toBe(false);
    expect(pushStateSpy).toHaveBeenCalledTimes(3);
  });
});

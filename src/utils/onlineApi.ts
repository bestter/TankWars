/**
 * Online multiplayer API / WebSocket base URLs.
 * Dev: local wrangler on :8787.
 * Prod (option B): VITE_API_BASE → workers.dev worker URL (cross-origin from Pages).
 */

const DEV_API_BASE = 'http://localhost:8787';
const DEV_WS_BASE = 'ws://localhost:8787';

/** Converts an HTTP(S) API base to the matching WS(S) base. */
export function apiBaseToWsBase(apiBase: string): string {
  return apiBase.replace(/^https:\/\//i, 'wss://').replace(/^http:\/\//i, 'ws://');
}

/** REST base for room creation (no trailing slash). */
export function getOnlineApiBase(): string {
  if (import.meta.env.DEV) {
    return DEV_API_BASE;
  }
  const configured = import.meta.env.VITE_API_BASE?.trim().replace(/\/$/, '') ?? '';
  return configured;
}

/** WebSocket base for lobby + combat (no trailing slash). */
export function getOnlineWsBase(): string {
  if (import.meta.env.DEV) {
    return DEV_WS_BASE;
  }
  const apiBase = getOnlineApiBase();
  if (apiBase) {
    return apiBaseToWsBase(apiBase);
  }
  if (typeof window !== 'undefined') {
    return `wss://${window.location.host}`;
  }
  return '';
}
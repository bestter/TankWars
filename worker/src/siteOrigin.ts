export const PAGES_ORIGIN = 'https://tankwars.pages.dev';

export function isAllowedSiteOrigin(origin: unknown, allowLocalOrigins: boolean): origin is string {
  return typeof origin === 'string' && (
    origin === 'https://tankwars-game.com' ||
    origin === PAGES_ORIGIN ||
    /^https:\/\/[a-zA-Z0-9-]+\.tankwars\.pages\.dev$/.test(origin) ||
    (allowLocalOrigins && /^http:\/\/(localhost|127\.0\.0\.1):(5173|4173|8787)$/.test(origin))
  );
}

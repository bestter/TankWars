/** Cloudflare's unequal-length pattern still invokes the comparison primitive.
 * https://developers.cloudflare.com/workers/examples/protect-against-timing-attacks/
 * This does not make the surrounding HTTP request constant-time.
 */
export function tokenMatches(received: string, expected: unknown): boolean {
  if (typeof expected !== 'string' || expected.length === 0) return false;
  if (typeof crypto.subtle.timingSafeEqual !== 'function') {
    console.error('[GameRoom] Secure token comparison unavailable');
    return false;
  }
  const encoder = new TextEncoder();
  const input = encoder.encode(received);
  const secret = encoder.encode(expected);
  return input.byteLength === secret.byteLength
    ? crypto.subtle.timingSafeEqual(input, secret)
    : !crypto.subtle.timingSafeEqual(input, input);
}

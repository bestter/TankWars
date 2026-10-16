export const MAX_COMBAT_MESSAGE_BYTES = 64 * 1024;

export function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

export function encodedCombatBytes(value: unknown): number {
  return utf8Bytes(JSON.stringify(value));
}

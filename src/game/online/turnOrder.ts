/**
 * Pure turn-order helpers shared by the client and the Cloudflare GameRoom DO.
 * Keep this free of DOM / Workers APIs so unit tests can import it directly.
 */

/**
 * Next living player index after `currentIndex` (wraps around).
 * Skips indices where `isDeadAt(i)` is true.
 * If every player is dead, advances exactly one step (same as a naive +1).
 */
export function nextLivingPlayerIndex(
  currentIndex: number,
  numPlayers: number,
  isDeadAt: (index: number) => boolean,
): number {
  if (numPlayers <= 0) return 0;
  const start = ((currentIndex % numPlayers) + numPlayers) % numPlayers;
  let idx = start;
  for (let i = 0; i < numPlayers; i++) {
    idx = (idx + 1) % numPlayers;
    if (!isDeadAt(idx)) return idx;
  }
  return (start + 1) % numPlayers;
}

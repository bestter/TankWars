/**
 * Round-end payload — a combat round ends on last man standing (0 or 1 tank alive),
 * or when every tank is destroyed (draw). Shop runs after this, not after a full turn cycle.
 * Distinct from TurnManager `turn` counter (individual shots within a round).
 */

import type { Player } from "./player";

export interface RoundEndPayload {
  /** Players still alive when the round ended */
  survivors: Player[];
  /** True when every tank was destroyed this round */
  isDraw: boolean;
  /** Set when exactly one tank remains */
  roundWinner: Player | null;
}

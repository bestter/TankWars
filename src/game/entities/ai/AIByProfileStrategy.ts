/**
 * TankWars - AIByProfileStrategy (dispatcher)
 *
 * Allows mixed AI profiles in one match (some 'v1-random' Mr. Simple, some 'v2-heuristic' IA OK).
 * Looks up the specific tank's aiProfile from the GameState snapshot and delegates.
 * This is the single instance wired in GameCanvas (satisfies "register new strategies" guideline).
 *
 * Falls back to simple for unknown/missing profiles (preserves all existing demos + v1 behavior).
 */

import type { AIEngine } from "./AIEngine";
import type { GameState } from "../../../types/game";
import type { TerrainManager } from "../../engine/Terrain";
import type { WeaponId } from "../../../types/weapon";
import { AISimpleStrategy } from "./AISimpleStrategy";
import { AIHeuristicStrategy } from "./AIHeuristicStrategy";
import { AISniperStrategy } from "./AISniperStrategy";
import { AISmartStrategy } from "./AISmartStrategy";

export class AIByProfileStrategy implements AIEngine {
  private readonly simple = new AISimpleStrategy();
  private readonly heuristic = new AIHeuristicStrategy();
  private readonly sniper = new AISniperStrategy();
  private readonly smart = new AISmartStrategy();

  async executeTurn(
    tankId: string,
    gameState: GameState,
    terrainManager: TerrainManager,
  ): Promise<{ angle: number; power: number; weaponId?: WeaponId }> {
    const p = gameState.players.find((pp) => pp.tank.id === tankId);
    const profile = p?.aiProfile ?? "v1-random";

    let delegate: AIEngine;
    if (profile === "v2-heuristic") {
      delegate = this.heuristic;
    } else if (profile === "v3-sniper") {
      delegate = this.sniper;
    } else if (profile === "v4-smart") {
      delegate = this.smart;
    } else {
      delegate = this.simple;
    }

    return delegate.executeTurn(tankId, gameState, terrainManager);
  }

  getResolutionFallback(): { angle: number; power: number } | null {
    // Conservative: use the simple one (safe for all profiles during timeout)
    return this.simple.getResolutionFallback?.() ?? null;
  }
}

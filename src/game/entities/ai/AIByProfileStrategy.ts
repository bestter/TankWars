/**
 * TankWars - AIByProfileStrategy (dispatcher)
 *
 * Allows mixed AI profiles in one match (some 'v1-random' Mr. Simple, some 'v2-heuristic' IA OK).
 * Looks up the specific tank's aiProfile from the GameState snapshot and delegates.
 * This is the single instance wired in GameCanvas (satisfies "register new strategies" guideline).
 *
 * Falls back to simple for unknown/missing profiles (preserves all existing demos + v1 behavior).
 * Advanced strategies (v2–v4) are lazy-loaded on first use to reduce initial bundle cost.
 */

import type { AIEngine } from "./AIEngine";
import type { GameState } from "../../../types/game";
import type { TerrainManager } from "../../engine/Terrain";
import type { WeaponId } from "../../../types/weapon";
import { AISimpleStrategy } from "./AISimpleStrategy";

type LazyAIEngine = AIEngine;

export class AIByProfileStrategy implements AIEngine {
  private readonly simple = new AISimpleStrategy();
  private heuristic: LazyAIEngine | null = null;
  private sniper: LazyAIEngine | null = null;
  private smart: LazyAIEngine | null = null;

  private async loadHeuristic(): Promise<LazyAIEngine> {
    if (!this.heuristic) {
      const { AIHeuristicStrategy } = await import("./AIHeuristicStrategy");
      this.heuristic = new AIHeuristicStrategy();
    }
    return this.heuristic;
  }

  private async loadSniper(): Promise<LazyAIEngine> {
    if (!this.sniper) {
      const { AISniperStrategy } = await import("./AISniperStrategy");
      this.sniper = new AISniperStrategy();
    }
    return this.sniper;
  }

  private async loadSmart(): Promise<LazyAIEngine> {
    if (!this.smart) {
      const { AISmartStrategy } = await import("./AISmartStrategy");
      this.smart = new AISmartStrategy();
    }
    return this.smart;
  }

  async executeTurn(
    tankId: string,
    gameState: GameState,
    terrainManager: TerrainManager,
  ): Promise<{ angle: number; power: number; weaponId?: WeaponId }> {
    const p = gameState.players.find((pp) => pp.tank.id === tankId);
    const profile = p?.aiProfile ?? "v1-random";

    if (profile === "v2-heuristic") {
      return (await this.loadHeuristic()).executeTurn(tankId, gameState, terrainManager);
    }
    if (profile === "v3-sniper") {
      return (await this.loadSniper()).executeTurn(tankId, gameState, terrainManager);
    }
    if (profile === "v4-smart") {
      return (await this.loadSmart()).executeTurn(tankId, gameState, terrainManager);
    }

    return this.simple.executeTurn(tankId, gameState, terrainManager);
  }

  getResolutionFallback(): { angle: number; power: number } | null {
    // Conservative: use the simple one (safe for all profiles during timeout)
    return this.simple.getResolutionFallback?.() ?? null;
  }
}
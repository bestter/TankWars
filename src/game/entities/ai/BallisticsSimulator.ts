/**
 * Shared ballistic trajectory simulation for AI aiming strategies.
 * Single source of truth aligned with PhysicsEngine launch coordinates and drag.
 */

import type { TerrainManager } from "../../engine/Terrain";
import type { WeaponId } from "../../../types/weapon";

const BALLISTICS_BASE_SPEED = 6.0;
const BALLISTICS_DT = 1 / 120;
const BALLISTICS_MAX_STEPS = 420;
const BALLISTICS_DRAG = 0.28;

const BARREL_LENGTH = 20;
const BARREL_START_Y_OFFSET = 13;

export interface ShotResult {
  landX: number;
  landY: number;
  hitTerrainEarly: boolean;
}

export interface BallisticSearchConfig {
  sx: number;
  sy: number;
  tx: number;
  ty: number;
  wind: number;
  gravity: number;
  terrain: TerrainManager;
  isRight: boolean;
  aMin: number;
  aMax: number;
  /** Coarse angle sweep step (degrees). */
  coarseStep: number;
  /** Fine refinement step around the coarse winner (degrees). */
  fineStep: number;
  /** Half-window (degrees) for fine refinement. */
  fineWindow: number;
  powerLo: number;
  powerHi: number;
  powerIterations: number;
  obstaclePenaltyHigh?: number;
  obstaclePenaltyLow?: number;
  selfHarmPenalty?: (landX: number, landY: number) => number;
  weaponId?: WeaponId;
  /** Stop refining once total error drops below this threshold. */
  earlyExitError?: number;
}

export interface BallisticSearchResult {
  angle: number;
  power: number;
  err: number;
}

function launchFromBarrel(
  sx: number,
  sy: number,
  angleDeg: number,
): { x: number; y: number; vx: number; vy: number } {
  const rad = (angleDeg * Math.PI) / 180;
  const barrelStartY = sy - BARREL_START_Y_OFFSET;
  const x = sx + Math.cos(rad) * BARREL_LENGTH;
  const y = barrelStartY - Math.sin(rad) * BARREL_LENGTH;
  const speed = BALLISTICS_BASE_SPEED;
  return {
    x,
    y,
    vx: Math.cos(rad) * speed,
    vy: -Math.sin(rad) * speed,
  };
}

/** Standard projectile trajectory (missile, driller, bullet, etc.). */
export function simulateShot(
  sx: number,
  sy: number,
  angleDeg: number,
  power: number,
  wind: number,
  gravity: number,
  terrain: TerrainManager,
): ShotResult {
  const launch = launchFromBarrel(sx, sy, angleDeg);
  let x = launch.x;
  let y = launch.y;
  let vx = launch.vx * power;
  let vy = launch.vy * power;
  let landX = x;
  let landY = y;
  let hitEarly = false;

  for (let step = 0; step < BALLISTICS_MAX_STEPS; step++) {
    vy += gravity * BALLISTICS_DT;
    vx += wind * BALLISTICS_DT;

    const sp = Math.hypot(vx, vy);
    if (sp > 4) {
      const drag = BALLISTICS_DRAG * sp * BALLISTICS_DT;
      vx -= (vx / sp) * drag;
      vy -= (vy / sp) * drag;
    }

    x += vx * BALLISTICS_DT;
    y += vy * BALLISTICS_DT;

    if (terrain.checkCollision(x, y)) {
      landX = x;
      landY = y;
      hitEarly = true;
      break;
    }
    if (x < -80 || x > terrain.width + 80 || y > terrain.height + 120) break;

    landX = x;
    landY = y;
  }

  return { landX, landY, hitTerrainEarly: hitEarly };
}

/** Grenade bounce + cluster-aware trajectory for Expert AI weapon selection. */
export function simulateSmartShot(
  sx: number,
  sy: number,
  angleDeg: number,
  power: number,
  wind: number,
  gravity: number,
  terrain: TerrainManager,
  weaponId: WeaponId,
): ShotResult {
  const launch = launchFromBarrel(sx, sy, angleDeg);
  let x = launch.x;
  let y = launch.y;
  let vx = launch.vx * power;
  let vy = launch.vy * power;
  let landX = x;
  let landY = y;
  let hitEarly = false;
  let bounceCount = 0;

  const isGrenade = weaponId === "GRENADE";

  for (let step = 0; step < BALLISTICS_MAX_STEPS; step++) {
    const prevVy = vy;
    vy += gravity * BALLISTICS_DT;
    vx += wind * BALLISTICS_DT;

    const sp = Math.hypot(vx, vy);
    if (sp > 4) {
      const drag = BALLISTICS_DRAG * sp * BALLISTICS_DT;
      vx -= (vx / sp) * drag;
      vy -= (vy / sp) * drag;
    }

    x += vx * BALLISTICS_DT;
    y += vy * BALLISTICS_DT;

    // Cluster apex split is a no-op in search (central submunition continues)
    void (weaponId === "CLUSTER" && prevVy < 0 && vy >= 0);

    if (terrain.checkCollision(x, y)) {
      if (isGrenade) {
        const surfaceY = terrain.getHeightAt(x);
        y = surfaceY - 1.2;
        bounceCount++;

        const speed = Math.hypot(vx, vy);
        const shouldExplode =
          bounceCount >= 4 || speed < 3.2 || Math.abs(vy) < 2.0;
        if (shouldExplode) {
          landX = x;
          landY = y;
          break;
        }
        vy = -vy * 0.64;
        vx *= 0.78;
      } else {
        landX = x;
        landY = y;
        hitEarly = true;
        break;
      }
    }
    if (x < -80 || x > terrain.width + 80 || y > terrain.height + 120) break;

    landX = x;
    landY = y;
  }

  return { landX, landY, hitTerrainEarly: hitEarly };
}

function computeShotError(res: ShotResult, config: BallisticSearchConfig): number {
  const {
    sx,
    tx,
    ty,
    isRight,
    obstaclePenaltyHigh = 10000,
    obstaclePenaltyLow = 0,
    selfHarmPenalty,
  } = config;

  const xErr = Math.abs(res.landX - tx);
  const yErr = Math.abs(res.landY - ty) * 0.35;

  let obstaclePenalty = 0;
  if (res.hitTerrainEarly) {
    const isBetween = isRight
      ? res.landX > sx + 20 && res.landX < tx - 35
      : res.landX < sx - 20 && res.landX > tx + 35;
    obstaclePenalty = isBetween ? obstaclePenaltyHigh : obstaclePenaltyLow;
  }

  const selfPenalty = selfHarmPenalty ? selfHarmPenalty(res.landX, res.landY) : 0;
  return xErr + yErr + obstaclePenalty + selfPenalty;
}

function evaluateAnglePower(
  angle: number,
  config: BallisticSearchConfig,
): { power: number; err: number } {
  let lo = config.powerLo;
  let hi = config.powerHi;
  let bestPower = (lo + hi) / 2;
  let bestErr = 999999;

  for (let iter = 0; iter < config.powerIterations; iter++) {
    const p = (lo + hi) / 2;
    const res =
      config.weaponId &&
      (config.weaponId === "GRENADE" || config.weaponId === "CLUSTER")
        ? simulateSmartShot(
            config.sx,
            config.sy,
            angle,
            p,
            config.wind,
            config.gravity,
            config.terrain,
            config.weaponId,
          )
        : simulateShot(
            config.sx,
            config.sy,
            angle,
            p,
            config.wind,
            config.gravity,
            config.terrain,
          );

    const err = computeShotError(res, config);
    if (err < bestErr) {
      bestErr = err;
      bestPower = p;
    }

    if (res.landX < config.tx) {
      if (config.isRight) lo = p;
      else hi = p;
    } else {
      if (config.isRight) hi = p;
      else lo = p;
    }
  }

  return { power: bestPower, err: bestErr };
}

function sweepAngles(
  config: BallisticSearchConfig,
  step: number,
  from: number,
  to: number,
  seed: BallisticSearchResult,
): BallisticSearchResult {
  let best = seed;

  for (let a = from; a <= to; a += step) {
    const { power, err } = evaluateAnglePower(a, config);
    if (err < best.err) {
      best = { angle: a, power, err };
    }
    if (config.earlyExitError != null && best.err <= config.earlyExitError) {
      break;
    }
  }

  return best;
}

/**
 * Two-phase ballistic search: coarse sweep then fine refinement around the best angle.
 */
export function searchBallisticSolution(
  config: BallisticSearchConfig,
): BallisticSearchResult {
  const fallback = {
    angle: config.isRight ? 55 : 125,
    power: 60,
    err: 999999,
  };

  let best = sweepAngles(config, config.coarseStep, config.aMin, config.aMax, fallback);

  if (config.fineStep > 0 && config.fineWindow > 0) {
    const fineMin = Math.max(config.aMin, best.angle - config.fineWindow);
    const fineMax = Math.min(config.aMax, best.angle + config.fineWindow);
    best = sweepAngles(config, config.fineStep, fineMin, fineMax, best);
  }

  return best;
}
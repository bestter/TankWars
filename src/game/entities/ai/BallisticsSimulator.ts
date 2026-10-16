/**
 * Shared ballistic trajectory simulation for AI aiming strategies.
 * Single source of truth aligned with PhysicsEngine launch coordinates and drag.
 */

import type { TerrainManager } from "../../engine/Terrain";
import type { WeaponId } from "../../../types/weapon";
import { GRENADE_MAX_BOUNCES, grenadeBounceParams } from "../../../types/terrain";

import { BALLISTICS_DT, BALLISTICS_DRAG, launchFromBarrel, advanceProjectile, projectileOutOfBounds } from "../../engine/projectileMotion";
import { insideTankHitbox, TANK_HITBOX_WIDTH, TANK_HITBOX_HEIGHT } from "../../combatConstants";
import type { Player } from "../../../types/player";
import { finalizeAdvancedAim, type AimCommand } from "./aimCorruption";

export const BALLISTICS_MAX_STEPS = 420;

export const BULLDOZER_DIRECT_SEARCH_MAX_SIMULATIONS = 512;
export const BULLDOZER_DIRECT_COARSE_ANGLE_STEP = 5;
export const BULLDOZER_DIRECT_COARSE_POWER_STEP = 15;
export const BULLDOZER_DIRECT_FINE_ANGLE_STEP = 1.5;
export const BULLDOZER_DIRECT_FINE_POWER_STEP = 5;
export const BULLDOZER_DIRECT_FINE_WINDOW = 4.5;
export const BULLDOZER_DIRECT_NEAR_DISTANCE = 8;

export interface DirectBulldozerConfig {
  readonly shooter: Player;
  readonly target: Player;
  readonly players: readonly Player[];
  readonly terrain: TerrainManager;
  readonly wind: number;
  readonly gravity: number;
}

export interface DirectBulldozerTrajectory {
  readonly terminal: "tank" | "terrain" | "out-of-bounds" | "incomplete";
  readonly targetId?: string;
  readonly x: number;
  readonly y: number;
  readonly vx: number;
  readonly steps: number;
  readonly nearDistance: number;
}

/** Pure first-event trace, with the same owner guard and roster order as combat. */
export function simulateDirectBulldozerTrajectory(
  config: DirectBulldozerConfig, command: Readonly<AimCommand>,
): DirectBulldozerTrajectory {
  const { shooter, target, players, terrain, wind, gravity } = config;
  const motion = launchFromBarrel(shooter.tank.position.x, shooter.tank.position.y, command.angle, command.power);
  let hasLeftOwnerHitbox = false;
  let nearDistance = Number.POSITIVE_INFINITY;
  for (let step = 1; step <= BALLISTICS_MAX_STEPS; step++) {
    advanceProjectile(motion, BALLISTICS_DT, gravity, wind);
    if (projectileOutOfBounds(motion, terrain.width, terrain.height)) {
      return { ...motion, terminal: "out-of-bounds", steps: step, nearDistance };
    }
    const position = target.tank.position;
    nearDistance = Math.min(nearDistance, Math.hypot(
      Math.max(0, Math.abs(motion.x - position.x) - TANK_HITBOX_WIDTH / 2),
      Math.max(0, position.y - TANK_HITBOX_HEIGHT - motion.y, motion.y - position.y),
    ));
    if (!insideTankHitbox(motion.x, motion.y, shooter.tank.position)) hasLeftOwnerHitbox = true;
    const hit = players.find((player) => !player.tank.isDead &&
      (player.id !== shooter.id || hasLeftOwnerHitbox) &&
      insideTankHitbox(motion.x, motion.y, player.tank.position));
    if (hit) return { ...motion, terminal: "tank", targetId: hit.id, steps: step, nearDistance };
    if (terrain.checkCollision(motion.x, motion.y)) {
      return { ...motion, terminal: "terrain", steps: step, nearDistance };
    }
  }
  return { ...motion, terminal: "incomplete", steps: BALLISTICS_MAX_STEPS, nearDistance };
}

/** Coarse candidates first, then near-AABB seeds in their original traversal order. */
export function* searchDirectBulldozerSolutions(config: DirectBulldozerConfig): Generator<{
  command: Readonly<AimCommand>; trajectory: DirectBulldozerTrajectory;
}> {
  const right = config.target.tank.position.x > config.shooter.tank.position.x;
  const minimum = right ? 15 : 95;
  const maximum = right ? 85 : 165;
  const seen = new Set<string>();
  const seeds: AimCommand[] = [];
  function trial(angle: number, power: number) {
    const command = finalizeAdvancedAim({
      angle: Math.max(6, Math.min(174, angle)), power: Math.max(25, Math.min(95, power)),
    });
    const key = `${command.angle}:${command.power}`;
    if (seen.has(key)) return null;
    seen.add(key);
    return { command, trajectory: simulateDirectBulldozerTrajectory(config, command) };
  }
  for (let angle = minimum; angle <= maximum; angle += BULLDOZER_DIRECT_COARSE_ANGLE_STEP) {
    for (let power = 20; power <= 95; power += BULLDOZER_DIRECT_COARSE_POWER_STEP) {
      if (seen.size >= BULLDOZER_DIRECT_SEARCH_MAX_SIMULATIONS) return;
      const candidate = trial(angle, power);
      if (!candidate) continue;
      if (candidate.trajectory.nearDistance <= BULLDOZER_DIRECT_NEAR_DISTANCE) seeds.push({ angle, power });
      yield candidate;
    }
  }
  for (const seed of seeds) {
    const from = Math.max(minimum, seed.angle - BULLDOZER_DIRECT_FINE_WINDOW);
    const to = Math.min(maximum, seed.angle + BULLDOZER_DIRECT_FINE_WINDOW);
    for (let angle = from; angle <= to; angle += BULLDOZER_DIRECT_FINE_ANGLE_STEP) {
      for (let power = Math.max(20, seed.power - 15); power <= Math.min(95, seed.power + 15);
        power += BULLDOZER_DIRECT_FINE_POWER_STEP) {
        if (seen.size >= BULLDOZER_DIRECT_SEARCH_MAX_SIMULATIONS) return;
        const candidate = trial(angle, power);
        if (candidate) yield candidate;
      }
    }
  }
}

export interface ShotResult {
  landX: number;
  landY: number;
  hitTerrainEarly: boolean;
  complete?: boolean;
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
  /** Restricted searches must also bound the initial fallback. */
  projectFallbackToCone?: boolean;
}

export interface BallisticSearchResult {
  angle: number;
  power: number;
  err: number;
  /** False when the chosen trajectory exhausted its step bound or no trial was evaluated. */
  complete?: boolean;
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
  let complete = false;

  for (let step = 0; step < BALLISTICS_MAX_STEPS; step++) {
    vy += gravity * BALLISTICS_DT;
    vx += wind * BALLISTICS_DT;

    const sp = Math.sqrt(vx * vx + vy * vy);
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
      complete = true;
      break;
    }
    if (x < -80 || x > terrain.width + 80 || y > terrain.height + 120) {
      complete = true;
      break;
    }

    landX = x;
    landY = y;
  }

  return { landX, landY, hitTerrainEarly: hitEarly, complete };
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
  let complete = false;
  let bounceCount = 0;

  const isGrenade = weaponId === "GRENADE";

  for (let step = 0; step < BALLISTICS_MAX_STEPS; step++) {
    const prevVy = vy;
    vy += gravity * BALLISTICS_DT;
    vx += wind * BALLISTICS_DT;

    const sp = Math.sqrt(vx * vx + vy * vy);
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
        const bounce = grenadeBounceParams(terrain.getMaterialAt(x), () => 0.5);

        const speed = Math.hypot(vx, vy);
        const shouldExplode =
          bounce.explodeOnContact ||
          bounceCount >= GRENADE_MAX_BOUNCES ||
          speed < 3.2 ||
          Math.abs(vy) < 2.0;
        if (shouldExplode) {
          landX = x;
          landY = y;
          complete = true;
          break;
        }
        vy = -vy * bounce.restitution;
        vx *= bounce.friction;
      } else {
        landX = x;
        landY = y;
        hitEarly = true;
        complete = true;
        break;
      }
    }
    if (x < -80 || x > terrain.width + 80 || y > terrain.height + 120) {
      complete = true;
      break;
    }

    landX = x;
    landY = y;
  }

  return { landX, landY, hitTerrainEarly: hitEarly, complete };
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
): { power: number; err: number; complete: boolean } {
  let lo = config.powerLo;
  let hi = config.powerHi;
  let bestPower = (lo + hi) / 2;
  let bestErr = 999999;
  let bestComplete = false;

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
    const complete = res.complete !== false;
    // A truncated endpoint must not displace a resolved trajectory.
    if ((complete && !bestComplete) || (complete === bestComplete && err < bestErr)) {
      bestErr = err;
      bestPower = p;
      bestComplete = complete;
    }

    if (res.landX < config.tx) {
      if (config.isRight) lo = p;
      else hi = p;
    } else {
      if (config.isRight) hi = p;
      else lo = p;
    }
  }

  return { power: bestPower, err: bestErr, complete: bestComplete };
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
    const { power, err, complete } = evaluateAnglePower(a, config);
    const bestComplete = best.complete === true;
    if ((complete && !bestComplete) || (complete === bestComplete && err < best.err)) {
      best = { angle: a, power, err, complete };
    }
    if (best.complete === true && config.earlyExitError != null && best.err <= config.earlyExitError) {
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
    angle: config.projectFallbackToCone
      ? Math.max(config.aMin, Math.min(config.aMax, config.isRight ? 55 : 125))
      : config.isRight ? 55 : 125,
    power: 60,
    err: 999999,
    complete: false,
  };

  let best = sweepAngles(config, config.coarseStep, config.aMin, config.aMax, fallback);

  if (config.fineStep > 0 && config.fineWindow > 0) {
    const fineMin = Math.max(config.aMin, best.angle - config.fineWindow);
    const fineMax = Math.min(config.aMax, best.angle + config.fineWindow);
    best = sweepAngles(config, config.fineStep, fineMin, fineMax, best);
  }

  return best;
}

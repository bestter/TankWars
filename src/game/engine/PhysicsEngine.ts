import { secureRandom } from '../../utils/random';
/**
 * TankWars - PhysicsEngine
 *
 * Gestionnaire dédié aux projectiles et à la physique de tir.
 * Séparé du GameEngine pour plus de clarté et de maintenabilité.
 *
 * Règles respectées :
 * - TypeScript strict, zéro `any`
 * - Utilise WEAPON_REGISTRY pour les caractéristiques des armes
 * - Utilise TerrainManager pour les collisions et destructions
 * - Ballistic motion: gravity, horizontal wind acceleration, light air drag
 */

import { WEAPON_REGISTRY, type WeaponId } from "../../types/weapon";
import type { TerrainManager } from "./Terrain";
import { VGA_PALETTE } from "../../types/game";
import type { TankManager } from "../entities/TankManager";

export interface Projectile {
  x: number;
  y: number;
  vx: number;
  vy: number;
  weaponId: WeaponId;
  /** Who fired this (player id) for kill/damage attribution at round end */
  ownerId?: string;
  /** Owner tank primary color for harmonized projectile visuals (inherits from firer) */
  ownerColor?: string;
  /** For cluster: mark sub-munitions so they don't re-split; also track apex */
  isSubmunition?: boolean;
  lastVy?: number;
  /** Original cannon power/angle (affects sub-munition spread for cluster) */
  initialAngle?: number;
  initialPower?: number;
  /** Number of terrain bounces so far (only used by GRENADE physicsType) */
  bounceCount?: number;
  /** Flag showing if projectile has exited its owner tank's hitbox to avoid self-sabotage */
  hasLeftOwnerHitbox?: boolean;
}

export interface ProjectileHitEvent {
  x: number;
  y: number;
  weaponId: WeaponId;
}

/** Air drag coefficient (1/s); slows shells slightly without overpowering wind. */
const PROJECTILE_DRAG = 0.28;

export class PhysicsEngine {
  private projectiles: Projectile[] = [];

  /** Callback appelé lorsqu'un projectile touche le terrain ou un tank (direct hit). */
  public onProjectileHit?: (event: ProjectileHitEvent) => void;

  /**
   * Lance un nouveau projectile.
   * L'angle est en degrés (0 = horizontal droite, positif = vers le haut).
   * L'axe Y est inversé pour correspondre au canvas (Y vers le bas).
   */
  public launchProjectile(
    startX: number,
    startY: number,
    angle: number,
    power: number,
    weaponId: WeaponId,
    ownerId?: string,
    ownerColor?: string,
  ): void {
    const rad = (angle * Math.PI) / 180;

    // Vitesse de base raisonnable pour un canvas ~800px
    const baseSpeed = 4.2;
    const speed = power * baseSpeed;

    const vx = Math.cos(rad) * speed;
    const vy = -Math.sin(rad) * speed; // négatif = vers le haut dans le canvas

    this.projectiles.push({
      x: startX,
      y: startY,
      vx,
      vy,
      weaponId,
      ownerId,
      ownerColor,
      initialAngle: angle,
      initialPower: power,
    });

    this.previousCount = this.projectiles.length;
  }

  /**
   * Met à jour tous les projectiles.
   * Applique gravité, vent, collisions terrain/tanks et limites d'écran.
   */
  public updateProjectiles(
    dt: number,
    gravity: number,
    wind: number,
    terrainManager: TerrainManager,
    tankManager?: TankManager,
  ): void {
    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      const p = this.projectiles[i];

      const prevVy = p.lastVy ?? p.vy;

      // Integrate velocity (semi-implicit): gravity + constant horizontal wind accel
      p.vy += gravity * dt;
      p.vx += wind * dt;

      // Light air resistance (opposes motion; wind still drifts trajectories over time)
      const speed = Math.hypot(p.vx, p.vy);
      if (speed > 4) {
        const drag = PROJECTILE_DRAG * speed * dt;
        p.vx -= (p.vx / speed) * drag;
        p.vy -= (p.vy / speed) * drag;
      }

      p.lastVy = p.vy;

      p.x += p.vx * dt;
      p.y += p.vy * dt;

      // Sortie d'écran (limites latérales et inférieures)
      const outOfBounds =
        p.x < -60 ||
        p.x > terrainManager.width + 60 ||
        p.y > terrainManager.height + 150;

      if (outOfBounds) {
        this.projectiles.splice(i, 1);
        continue;
      }

      // Cluster bomb: split into sub-munitions in the air (at apex: transition from rising to falling)
      // Subs are released with spread velocities influenced by cannon power + direction (via initial + current vel)
      // They continue under wind/gravity and will blow on their own impacts (stronger multi-hit effect).
      if (
        p.weaponId === "CLUSTER" &&
        !p.isSubmunition &&
        prevVy < 0 &&
        p.vy >= 0
      ) {
        this.splitCluster(i, p);
        continue;
      }

      // Direct collision with a tank (the shell touches or flies into the tank body).
      // Check tanks BEFORE terrain so a low trajectory that clips a tank explodes on the tank
      // (not buried in ground). The impact uses the projectile's current position and the
      // weapon's own rules (blastRadius, damage, special direct-kill zones like nuke/thermo, etc.).
      let collision = false;
      if (tankManager) {
        let ignoreOwnerId: string | undefined = undefined;
        if (p.ownerId && !p.hasLeftOwnerHitbox) {
          const ownerPlayer = tankManager
            .getPlayers()
            .find((pl) => pl.id === p.ownerId);
          if (ownerPlayer) {
            const oTank = ownerPlayer.tank;
            const tankWidth = 24;
            const tankHeight = 15;
            const insideOwner =
              p.x >= oTank.position.x - tankWidth / 2 &&
              p.x <= oTank.position.x + tankWidth / 2 &&
              p.y >= oTank.position.y - tankHeight &&
              p.y <= oTank.position.y;

            if (insideOwner) {
              ignoreOwnerId = p.ownerId;
            } else {
              p.hasLeftOwnerHitbox = true;
            }
          }
        }
        collision = tankManager.checkTankCollision(p.x, p.y, ignoreOwnerId);
      }

      if (collision) {
        this.handleImpact(i, p, terrainManager, tankManager, true);
        continue;
      }

      // Collision avec le terrain
      if (terrainManager.checkCollision(p.x, p.y)) {
        const weapon = WEAPON_REGISTRY[p.weaponId];
        if (weapon?.physicsType === "grenade") {
          this.bounceGrenade(i, p, terrainManager, tankManager);
          continue;
        } else {
          this.handleImpact(i, p, terrainManager, tankManager, false);
        }
      }
    }

    this.checkSettlement();
  }

  /**
   * Gère l'impact d'un projectile (terrain ou tank direct hit) :
   * - Destruction du terrain
   * - Application des dégâts aux tanks (si TankManager fourni)
   * - Mise à jour des positions des tanks (chute)
   * - Suppression du projectile
   */
  private handleImpact(
    index: number,
    p: Projectile,
    terrainManager: TerrainManager,
    tankManager?: TankManager,
    isDirectHit: boolean = false,
  ): void {
    const weapon = WEAPON_REGISTRY[p.weaponId];
    const blastRadius = weapon?.blastRadius ?? 28;
    const maxDamage = weapon?.damage ?? 35;

    console.log(
      `[EXPLOSION] pos=(${p.x.toFixed(1)}, ${p.y.toFixed(1)}) radius=${blastRadius} weapon=${p.weaponId} owner=${p.ownerId ?? "unknown"}`,
    );

    // 1. Détruire le terrain
    terrainManager.destroyTerrain(p.x, p.y, blastRadius);

    // 2. Appliquer les dégâts aux tanks (nouveau système)
    if (tankManager) {
      tankManager.applyExplosionDamage(p.x, p.y, blastRadius, maxDamage, p.ownerId, p.weaponId, isDirectHit);
      tankManager.updateTankPositions(terrainManager);
      tankManager.checkTankBurial(terrainManager); // Vérifie immédiatement les tanks enterrés
    }

    // 3. Notifier l'extérieur
    this.onProjectileHit?.({
      x: p.x,
      y: p.y,
      weaponId: p.weaponId,
    });

    // 4. Retirer le projectile
    this.projectiles.splice(index, 1);
  }

  /**
   * Split a CLUSTER parent (at apex) into sub-munitions released in the air.
   * Sub-munitions get velocities derived from parent's current trajectory + spread
   * influenced by original cannon power and direction. They are affected by wind
   * (and gravity) after release, and each will impact/explode independently (using
   * CLUSTER's blast/damage rules for multiple spread-out hits, making it stronger).
   * Parent is removed without its own explosion.
   */
  private splitCluster(parentIndex: number, p: Projectile): void {
    const numSubs = 5; // enough to make cluster noticeably stronger with spread
    const power = p.initialPower ?? 50;
    const maxSpreadRad = (Math.PI / 7) * (power / 70); // wider spread for higher power shots
    const currentSpeed = Math.hypot(p.vx, p.vy);
    const dir = Math.atan2(p.vy, p.vx);

    for (let k = 0; k < numSubs; k++) {
      const frac = (k - (numSubs - 1) / 2) / (numSubs - 1);
      const spread = frac * maxSpreadRad * (0.7 + secureRandom() * 0.6);
      const subDir = dir + spread;

      // subs get a fraction of current speed + variation; higher power gives more energetic subs
      const subSpeed = currentSpeed * (0.5 + secureRandom() * 0.4) * (0.65 + (power / 100) * 0.6);
      const subVx = Math.cos(subDir) * subSpeed;
      const subVy = Math.sin(subDir) * subSpeed;

      // release near parent pos, offset slightly along original dir (prevents immediate re-collision)
      const offset = 2.5;
      const relX = p.x + Math.cos(dir) * offset;
      const relY = p.y + Math.sin(dir) * offset;

      this.projectiles.push({
        x: relX,
        y: relY,
        vx: subVx,
        vy: subVy,
        weaponId: p.weaponId,
        ownerId: p.ownerId,
        ownerColor: p.ownerColor,
        isSubmunition: true,
      });
    }

    // remove the parent (it disperses the bomblets in air; no terrain hit from parent itself)
    this.projectiles.splice(parentIndex, 1);
  }

  /**
   * Handles bouncing behavior for GRENADE (physicsType === 'grenade').
   * On terrain contact: reflects velocity with energy loss + friction, increments bounce count.
   * After a few bounces (or when energy is low) it detonates via handleImpact (crater + damage).
   * Direct tank hits always explode immediately (handled before reaching here).
   * This makes the grenade "rebond" as advertised ("Grenade à rebond").
   */
  private bounceGrenade(
    index: number,
    p: Projectile,
    terrainManager: TerrainManager,
    tankManager?: TankManager,
  ): void {
    const surfaceY = terrainManager.getHeightAt(p.x);

    // Pop the projectile just above the surface to prevent sticking / re-trigger this frame.
    // Use the current x for surface query (heightmap is per-column).
    p.y = surfaceY - 1.2;

    const bounceCount = (p.bounceCount ?? 0) + 1;
    p.bounceCount = bounceCount;

    // Check if this contact should cause detonation rather than another bounce.
    // Explodes on the Nth bounce or when nearly stopped (prevents infinite micro-hops).
    // 4 allows 3 visible bounces which feels good for "grenade à rebond" on rough maps.
    const speed = Math.hypot(p.vx, p.vy);
    const MAX_BOUNCES = 4;
    const shouldExplode =
      bounceCount >= MAX_BOUNCES || speed < 3.2 || Math.abs(p.vy) < 2.0;

    if (shouldExplode) {
      // Detonate at (near) the contact point — same path as normal shells for damage/terrain.
      this.handleImpact(index, p, terrainManager, tankManager);
      return;
    }

    // Apply bounce physics (retro artillery feel with lossy bounces).
    // Vertical restitution: controls how high it bounces back up.
    const restitution = 0.58 + secureRandom() * 0.12; // 0.58–0.70, slight natural variance
    p.vy = -p.vy * restitution;

    // Horizontal friction on "ground" contact + tiny randomness (irregular terrain effect).
    p.vx *= 0.78 + (secureRandom() - 0.5) * 0.06;

    // Tiny extra vertical impulse for lively but diminishing hops.
    p.vy += (secureRandom() - 0.5) * 0.5;

    // Guarantee a visible (if small) liftoff even on low-angle or final-ish bounces.
    if (p.vy > -1.0) {
      p.vy = -1.0 - secureRandom() * 1.2;
    }

    // Clamp absurd horizontal speeds after many skids (safety).
    if (Math.abs(p.vx) > 12) {
      p.vx = Math.sign(p.vx) * 12;
    }
  }

  /**
   * Dessine tous les projectiles actifs.
   * Style simple et performant (petit cercle blanc/rouge).
   */
  public draw(ctx: CanvasRenderingContext2D): void {
    for (const p of this.projectiles) {
      const weapon = WEAPON_REGISTRY[p.weaponId];
      // Inherit firer's tank color for visual harmonization (Step 4), fallback to weapon color or white
      ctx.fillStyle = p.ownerColor ?? weapon?.color ?? VGA_PALETTE.WHITE;

      let r = 2.5;
      if (p.weaponId === "CLUSTER" && !p.isSubmunition) {
        r = 4.5; // visibly larger "parent" shell for cluster (before it splits in air)
      } else if (p.isSubmunition) {
        r = 1.8; // slightly smaller bomblets
      } else if (p.weaponId === "GRENADE") {
        r = 3.2; // grenades are a bit chunkier to read during bounces
      }

      // Petit obus visible (cercle)
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.fill();

      // Petit point brillant au centre pour plus de lisibilité (keep high-contrast white)
      ctx.fillStyle = VGA_PALETTE.WHITE;
      ctx.fillRect(p.x - 0.5, p.y - 0.5, 1, 1);
    }
  }

  /** Retourne la liste des projectiles actifs (lecture seule) */
  public getProjectiles(): readonly Projectile[] {
    return this.projectiles;
  }

  /**
   * Supprime tous les projectiles en vol.
   * @param notifySettlement When false, avoids firing onAllProjectilesSettled (e.g. startNextRound during SHOP).
   */
  public clear(notifySettlement = true): void {
    const hadProjectiles = this.projectiles.length > 0;
    this.projectiles = [];
    this.previousCount = 0;

    if (hadProjectiles && notifySettlement) {
      this.onAllProjectilesSettled?.();
    }
  }

  /** Nombre de projectiles actuellement en simulation */
  public get count(): number {
    return this.projectiles.length;
  }

  /** Indique s'il y a au moins un projectile en vol (utilisé pour masquer les noms pendant les tirs) */
  public hasActiveProjectiles(): boolean {
    return this.projectiles.length > 0;
  }

  // === Settlement notification (one-shot when last projectile disappears) ===
  public onAllProjectilesSettled?: () => void;

  private previousCount = 0;

  /** Internal method called after each update to detect settlement */
  public checkSettlement(): void {
    const currentCount = this.projectiles.length;

    if (this.previousCount > 0 && currentCount === 0) {
      this.onAllProjectilesSettled?.();
    }

    this.previousCount = currentCount;
  }
}

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
 * - Physique parabolique simple (gravité + vent)
 */

import { WEAPON_REGISTRY, type WeaponId } from '../../types/weapon';
import type { TerrainManager } from './Terrain';
import { VGA_PALETTE } from '../../types/game';
import type { TankManager } from '../entities/TankManager';

export interface Projectile {
  x: number;
  y: number;
  vx: number;
  vy: number;
  weaponId: WeaponId;
  /** Who fired this (player id) for kill/damage attribution at round end */
  ownerId?: string;
}

export interface ProjectileHitEvent {
  x: number;
  y: number;
  weaponId: WeaponId;
}

export class PhysicsEngine {
  private projectiles: Projectile[] = [];

  /** Callback appelé lorsqu'un projectile touche le terrain */
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
    });
  }

  /**
   * Met à jour tous les projectiles.
   * Applique gravité, vent, collisions terrain et limites d'écran.
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

      // Physique
      p.vy += gravity * dt;
      p.vx += wind * dt;

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

      // Collision avec le terrain
      if (terrainManager.checkCollision(p.x, p.y)) {
        this.handleImpact(i, p, terrainManager, tankManager);
      }
    }

    this.checkSettlement();
  }

  /**
   * Gère l'impact d'un projectile :
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
  ): void {
    const weapon = WEAPON_REGISTRY[p.weaponId];
    const blastRadius = weapon?.blastRadius ?? 28;
    const maxDamage = weapon?.damage ?? 35;

    // 1. Détruire le terrain
    terrainManager.destroyTerrain(p.x, p.y, blastRadius);

    // 2. Appliquer les dégâts aux tanks (nouveau système)
    if (tankManager) {
      tankManager.applyExplosionDamage(p.x, p.y, blastRadius, maxDamage, p.ownerId);
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
   * Dessine tous les projectiles actifs.
   * Style simple et performant (petit cercle blanc/rouge).
   */
  public draw(ctx: CanvasRenderingContext2D): void {
    ctx.fillStyle = VGA_PALETTE.WHITE;

    for (const p of this.projectiles) {
      const weapon = WEAPON_REGISTRY[p.weaponId];
      // Utilise la couleur de l'arme si disponible, sinon blanc
      ctx.fillStyle = weapon?.color ?? VGA_PALETTE.WHITE;

      // Petit obus visible (cercle de 3px)
      ctx.beginPath();
      ctx.arc(p.x, p.y, 2.5, 0, Math.PI * 2);
      ctx.fill();

      // Petit point brillant au centre pour plus de lisibilité
      ctx.fillStyle = VGA_PALETTE.WHITE;
      ctx.fillRect(p.x - 0.5, p.y - 0.5, 1, 1);
    }
  }

  /** Retourne la liste des projectiles actifs (lecture seule) */
  public getProjectiles(): readonly Projectile[] {
    return this.projectiles;
  }

  /** Supprime tous les projectiles en vol */
  public clear(): void {
    const hadProjectiles = this.projectiles.length > 0;
    this.projectiles = [];
    this.previousCount = 0;

    if (hadProjectiles) {
      this.onAllProjectilesSettled?.();
    }
  }

  /** Nombre de projectiles actuellement en simulation */
  public get count(): number {
    return this.projectiles.length;
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

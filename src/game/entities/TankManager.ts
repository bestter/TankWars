/**
 * TankWars - TankManager
 *
 * Gestionnaire central des tanks et de leur état de combat.
 * Gère le spawn, la physique de chute après explosions, les dégâts et le rendu rétro.
 */

import type { Player } from '../../types/player';
import type { TerrainManager } from '../engine/Terrain';
import { VGA_PALETTE } from '../../types/game';

/** Surface Y at or below this offset from canvas bottom = no support (tank sinks). */
const BOTTOM_SUPPORT_MARGIN = 14;

/** Falling damage: 1 health point per this many pixels of downward travel while falling. */
const FALL_DAMAGE_LEVEL_HEIGHT = 2; // further increased damage (was 4) per user request for more punishing falls

export class TankManager {
  private players: Player[] = [];

  /** Internal velocities for gradual falling (key = tank.id). Enables sliding + floor sounds. */
  private velocities: Map<string, number> = new Map();

  /** Accumulated downward distance per tank while falling. Used to apply "1 damage per level". */
  private fallenDistances: Map<string, number> = new Map();

  /** Debug hook: called when a player dies so GameEngine can accumulate causes for the final summary */
  public onPlayerDied?: (playerId: string, cause: 'explosion' | 'burial', details: string) => void;

  /** Called (throttled by caller) while a tank has downward velocity after losing ground support (for scrape/slide SFX). */
  public onTankSliding?: (playerId: string) => void;

  /** Called when a (live) tank first contacts the absolute lowest pit floor during a fall (for heavy thud SFX). */
  public onTankTouchedFloor?: (playerId: string) => void;

  /** Remplace et prépare la liste des joueurs pour le combat */
  public setPlayers(players: Player[]): void {
    this.players = players;
    this.velocities.clear();
    this.fallenDistances.clear();
    for (const p of players) {
      this.velocities.set(p.tank.id, 0);
      this.fallenDistances.set(p.tank.id, 0);
    }
  }

  /** Clears fall velocities and fallen distance tracking (used on full match reset). */
  public clearVelocities(): void {
    this.velocities.clear();
    this.fallenDistances.clear();
  }

  public getPlayers(): ReadonlyArray<Player> {
    return this.players;
  }

  public getAlivePlayers(): Player[] {
    return this.players.filter((p) => !p.tank.isDead);
  }

  /** Returns the winner if only one player is still alive, otherwise null */
  public getWinner(): Player | null {
    const alive = this.getAlivePlayers();
    return alive.length === 1 ? alive[0] : null;
  }

  /**
   * True while any alive tank has positive downward velocity from applyGravity.
   * Used by TurnManager to block shooting and delay turn advancement until all tanks have landed.
   */
  public anyTankIsFalling(): boolean {
    for (const player of this.players) {
      const tank = player.tank;
      if (tank.isDead) continue;
      const vy = this.velocities.get(tank.id) ?? 0;
      if (vy > 0.05) {
        return true;
      }
    }
    return false;
  }

  /**
   * Place les tanks avec positions X aléatoires (distance minimale garantie).
   * Ajuste précisément la position Y pour qu'ils reposent sur le sol.
   * Tous les joueurs sont réinitialisés (health=100, isDead=false) et repositionnés.
   */
  public spawnTanks(players: Player[], terrain: TerrainManager): void {
    this.players = players;

    const count = players.length;
    if (count < 2 || count > 4) {
      console.warn('TankManager: recommended player count is between 2 and 4');
    }

    const margin = terrain.width * 0.13;
    const minX = margin;
    const maxX = terrain.width - margin;
    const minDist = 100;

    // Génération de positions X aléatoires pour tous les joueurs
    const xs = this.generateRandomPositions(count, minX, maxX, minDist);

    players.forEach((player, index) => {
      const tank = player.tank;

      // Position X aléatoire (triée pour cohérence gauche-droite)
      const x = xs[index];

      // Ancrage vertical exact sur le terrain
      const groundY = terrain.getHeightAt(x);

      tank.position = { x, y: groundY };

      // Réinitialisation complète de l'état de combat pour le début de manche
      tank.health = tank.maxHealth;
      tank.shield = tank.maxShield ?? Math.floor(tank.maxHealth * 0.4);
      tank.maxShield = tank.maxShield ?? Math.floor(tank.maxHealth * 0.4);
      tank.isDead = false;

      // Angle de départ par défaut (sensé pour le côté du terrain)
      tank.angle = x < terrain.width / 2 ? 45 : 135;
    });

    // Initialize velocities and fall tracking for new spawns
    this.velocities.clear();
    this.fallenDistances.clear();
    for (const p of players) {
      this.velocities.set(p.tank.id, 0);
      this.fallenDistances.set(p.tank.id, 0);
    }
  }

  /**
   * Génère N positions X aléatoires dans [minX, maxX] avec |xi-xj| >= minDist pour tout i!=j.
   * Retourne les positions triées. Utilise rejection sampling (N petit: 2-4).
   */
  private generateRandomPositions(
    count: number,
    minX: number,
    maxX: number,
    minDist: number,
  ): number[] {
    if (count <= 0) return [];
    if (count === 1) return [minX + (maxX - minX) / 2];

    const range = maxX - minX;
    const minSpan = (count - 1) * minDist;

    // Si la plage est trop petite pour garantir minDist → fallback équitable
    if (minSpan > range) {
      const step = range / (count - 1);
      return Array.from({ length: count }, (_, i) => minX + step * i);
    }

    const maxAttempts = 500;
    const perPosAttempts = 80;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const positions: number[] = [];

      for (let i = 0; i < count; i++) {
        let placed = false;
        for (let t = 0; t < perPosAttempts; t++) {
          const candidate = minX + Math.random() * range;
          if (positions.every((p) => Math.abs(p - candidate) >= minDist)) {
            positions.push(candidate);
            placed = true;
            break;
          }
        }
        if (!placed) break;
      }

      if (positions.length === count) {
        positions.sort((a, b) => a - b);
        return positions;
      }
    }

    // Fallback: répartition équitable (garantie de ne jamais bloquer)
    const step = range / (count - 1);
    return Array.from({ length: count }, (_, i) => minX + step * i);
  }

  public updateTankPositions(terrain: TerrainManager): void {
    // Post-impact kick only: give initial downward velocity so applyGravity (called every frame
    // from GameEngine) produces visible animated drops + sliding sounds. No more instant snaps
    // for normal craters (enables "tank is sliding" audio/animation).
    for (const player of this.players) {
      const tank = player.tank;
      if (tank.isDead) continue;

      const groundY = terrain.getHeightAt(tank.position.x);
      const pitFloorY = terrain.height - BOTTOM_SUPPORT_MARGIN;
      const id = tank.id;

      if (groundY >= pitFloorY) {
        // Pit: give strong kick so fall anim + floor-touch sound can play over frames
        if ((this.velocities.get(id) ?? 0) <= 0) {
          this.fallenDistances.set(id, 0);
        }
        const cur = this.velocities.get(id) ?? 0;
        this.velocities.set(id, Math.max(cur, 5.5));
      } else if (tank.position.y + 0.5 < groundY) {
        // Normal crater under tank: give kick so it falls gradually (was instant before)
        if ((this.velocities.get(id) ?? 0) <= 0) {
          this.fallenDistances.set(id, 0);
        }
        const cur = this.velocities.get(id) ?? 0;
        this.velocities.set(id, Math.max(cur + 2.5, 3.5));
      } else {
        // Resting or very close: snap exactly + zero vel (prevents float)
        if (Math.abs(tank.position.y - groundY) < 3) {
          tank.position.y = groundY;
          this.velocities.set(id, 0);
        }
      }
    }
  }

  /**
   * Applies gravity-based falling simulation for tanks that have lost ground (post-crater or pit).
   * Must be called every fixed-timestep frame from GameEngine.update (after projectile step).
   * Produces onTankSliding / onTankTouchedFloor callbacks (consumed by audio in GameEngine).
   * Gravity/terminal increased slightly for faster falling animation while keeping retro feel.
   */
  public applyGravity(dt: number, terrain: TerrainManager): void {
    const TANK_GRAVITY = 850; // px/s² — increased for slightly faster falling animation (was 580)
    const TERMINAL_V = 16.0;
    const pitFloorY = terrain.height - BOTTOM_SUPPORT_MARGIN;

    for (const player of this.players) {
      const tank = player.tank;
      if (tank.isDead) {
        this.velocities.delete(tank.id);
        this.fallenDistances.delete(tank.id);
        continue;
      }

      const id = tank.id;
      let vy = this.velocities.get(id) ?? 0;

      const groundY = terrain.getHeightAt(tank.position.x);
      const inPit = groundY >= pitFloorY || tank.position.y > pitFloorY;

      if (tank.position.y < groundY || inPit) {
        // Falling (normal crater or pit)
        vy = Math.min(vy + TANK_GRAVITY * dt, TERMINAL_V);
        const prevY = tank.position.y;
        tank.position.y += vy * dt;
        this.velocities.set(id, vy);

        // Instant death on touching lava (the exposed floor when no ground left)
        const lavaY = terrain.lavaTop;
        if (tank.position.y >= lavaY && !tank.isDead) {
          tank.isDead = true;
          const details = `touched lava (y=${tank.position.y.toFixed(1)} >= lavaTop=${lavaY})`;
          console.log(
            `[DEATH] player=${player.name} (id=${player.id}) cause=burial (lava) pos=(${tank.position.x.toFixed(1)},${tank.position.y.toFixed(1)})`
          );
          this.onPlayerDied?.(player.id, 'burial', details);
          this.velocities.delete(id);
          this.fallenDistances.delete(id);
          continue; // stop processing this tank for the frame
        }

        // === Fall damage: 1 point per FALL_DAMAGE_LEVEL_HEIGHT pixels of downward travel ===
        const deltaFall = tank.position.y - prevY;
        if (deltaFall > 0) {
          let fallen = (this.fallenDistances.get(id) ?? 0) + deltaFall;
          this.fallenDistances.set(id, fallen);

          const levelsCrossed = Math.floor(fallen / FALL_DAMAGE_LEVEL_HEIGHT);
          if (levelsCrossed > 0) {
            const dmg = levelsCrossed; // 1 per level
            const healthBefore = tank.health;
            tank.health = Math.max(0, tank.health - dmg);

            // keep remainder so we don't lose fractional progress
            fallen -= levelsCrossed * FALL_DAMAGE_LEVEL_HEIGHT;
            this.fallenDistances.set(id, fallen);

            console.log(
              `[FALL DMG] ${player.name} +${deltaFall.toFixed(1)}px (accum ${ (fallen + levelsCrossed * FALL_DAMAGE_LEVEL_HEIGHT).toFixed(1)}) -> ${dmg} dmg, health=${tank.health}`
            );

            if (healthBefore > 0 && tank.health <= 0) {
              tank.isDead = true;
              const totalFallen = (fallen + levelsCrossed * FALL_DAMAGE_LEVEL_HEIGHT).toFixed(0);
              const details = `fall damage (${dmg} pts after ~${totalFallen}px)`;
              console.log(
                `[DEATH] player=${player.name} (id=${player.id}) cause=burial (fall) pos=(${tank.position.x.toFixed(1)},${tank.position.y.toFixed(1)})`
              );
              this.onPlayerDied?.(player.id, 'burial', details);
              // Sad burial sound will be played by GameEngine wiring (per plan)
            }
          }
        }

        // Sliding / falling scrape sound trigger (throttled by GameEngine)
        if (vy > 0.7) {
          this.onTankSliding?.(player.id);
        }

        // Touch lowest floor (pit bottom) — one-shot per crossing
        const lowest = terrain.height - 6;
        if (prevY < lowest && tank.position.y >= lowest) {
          this.onTankTouchedFloor?.(player.id);
        }

        // Safety clamp
        if (tank.position.y > terrain.height + 80) {
          tank.position.y = terrain.height + 80;
        }
      } else {
        // Landed on normal terrain
        if (tank.position.y > groundY) {
          tank.position.y = groundY;
        }
        // Damp velocity on land
        if (Math.abs(vy) > 0.3) {
          vy *= 0.15;
        } else {
          vy = 0;
        }
        this.velocities.set(id, vy);
        this.fallenDistances.set(id, 0);
      }
    }
  }

  /**
   * Tanks die when they fall through the bottom of the map, sink after losing all ground support,
   * or touch the lava floor (exposed when terrain is completely destroyed at the bottom).
   * Lava touch = instant death regardless of health.
   */
  public checkTankBurial(terrain: TerrainManager): void {
    const pitFloorY = terrain.height - BOTTOM_SUPPORT_MARGIN;
    const lavaY = terrain.lavaTop;

    for (const player of this.players) {
      const tank = player.tank;
      if (tank.isDead) continue;

      const groundY = terrain.getHeightAt(tank.position.x);
      const unsupported = groundY >= pitFloorY;
      const fallenThrough = tank.position.y > terrain.height + 8;
      const touchedLava = tank.position.y >= lavaY;

      if (unsupported || fallenThrough || touchedLava) {
        tank.isDead = true;
        const cause = 'burial';
        let details: string;
        if (touchedLava) {
          details = `touched lava (y=${tank.position.y.toFixed(1)} >= lavaTop=${lavaY})`;
        } else if (unsupported) {
          details = `no ground support (surfaceY=${groundY.toFixed(1)} >= pitFloor=${pitFloorY.toFixed(1)})`;
        } else {
          details = `y=${tank.position.y.toFixed(1)} > height=${terrain.height} (fallen off screen)`;
        }
        console.log(
          `[DEATH] player=${player.name} (id=${player.id}) cause=${cause} pos=(${tank.position.x.toFixed(1)},${tank.position.y.toFixed(1)}) ${details}`
        );
        this.onPlayerDied?.(player.id, 'burial', details);
      }
    }
  }

  /**
   * Applique des dégâts d'explosion avec atténuation linéaire selon la distance.
   * Les dégâts sont d'abord absorbés par le bouclier, puis par la vie.
   * @param killerId - Optional shooter id (for round-end kill attribution; splash counts for the explosion's firer)
   * @returns Number of *new* kills caused by *this* explosion (for attribution to the killer)
   */
  public applyExplosionDamage(
    explosionX: number,
    explosionY: number,
    radius: number,
    maxDamage: number,
    killerId?: string,
  ): number {
    let killsThisExplosion = 0;

    for (const player of this.players) {
      const tank = player.tank;
      if (tank.isDead) continue;

      const dx = tank.position.x - explosionX;
      const dy = tank.position.y - explosionY;
      const distance = Math.sqrt(dx * dx + dy * dy);

      if (distance > radius) continue;

      // Dégâts dégressifs linéaires
      const falloff = 1 - distance / radius;
      const damage = maxDamage * Math.max(0, falloff);

      if (damage <= 0) continue;

      const healthBefore = tank.health;

      // Bouclier en priorité
      let remainingDamage = damage;

      if (tank.shield > 0) {
        const absorbed = Math.min(remainingDamage, tank.shield);
        tank.shield -= absorbed;
        remainingDamage -= absorbed;
      }

      if (remainingDamage > 0) {
        tank.health = Math.max(0, tank.health - remainingDamage);
      }

      if (healthBefore > 0 && tank.health <= 0) {
        tank.isDead = true;
        const details = `explosion by ${killerId ?? 'unknown'} (damage=${damage.toFixed(1)})`;
        console.log(
          `[DEATH] player=${player.name} (id=${player.id}) cause=explosion pos=(${tank.position.x.toFixed(1)},${tank.position.y.toFixed(1)}) killer=${killerId ?? 'unknown'}`
        );
        this.onPlayerDied?.(player.id, 'explosion', details);
        if (killerId) {
          killsThisExplosion++;
        }
      }
    }

    return killsThisExplosion;
  }

  /**
   * Rendu rétro des tanks (style VGA 16 couleurs).
   * Affiche optionnellement les noms des joueurs (masqués pendant le vol des projectiles).
   */
  public draw(ctx: CanvasRenderingContext2D, showPlayerNames: boolean = true): void {
    const tankWidth = 14;
    const tankHeight = 8;

    for (const player of this.players) {
      const tank = player.tank;
      if (tank.isDead) continue;

      const { x, y } = tank.position;
      const color = tank.color;

      // === Corps du tank (rectangle rétro) ===
      ctx.fillStyle = color;
      ctx.fillRect(x - tankWidth / 2, y - tankHeight, tankWidth, tankHeight);

      // Bordure sombre pour effet rétro
      ctx.strokeStyle = VGA_PALETTE.DARK_GRAY;
      ctx.lineWidth = 1;
      ctx.strokeRect(x - tankWidth / 2, y - tankHeight, tankWidth, tankHeight);

      // === Tourelle (petit cercle sur le tank) ===
      const turretRadius = 5;
      ctx.fillStyle = VGA_PALETTE.DARK_GRAY;
      ctx.beginPath();
      ctx.arc(x, y - tankHeight + 1, turretRadius, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(x, y - tankHeight + 1, turretRadius - 1.5, 0, Math.PI * 2);
      ctx.fill();

      // === Canon (barrel) qui pivote selon l'angle ===
      const angleRad = (tank.angle * Math.PI) / 180;
      const barrelLength = 18;       // Plus long pour bien voir l'angle
      const barrelThickness = 3;

      // Le canon part du centre de la tourelle
      const barrelStartY = y - tankHeight + 1;

      const barrelEndX = x + Math.cos(angleRad) * barrelLength;
      const barrelEndY = barrelStartY + Math.sin(angleRad) * barrelLength * -1; // inversion Y

      // Ombre du canon
      ctx.strokeStyle = VGA_PALETTE.DARK_GRAY;
      ctx.lineWidth = barrelThickness + 2;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(x, barrelStartY);
      ctx.lineTo(barrelEndX, barrelEndY);
      ctx.stroke();

      // Canon principal (couleur du joueur)
      ctx.strokeStyle = color;
      ctx.lineWidth = barrelThickness;
      ctx.beginPath();
      ctx.moveTo(x, barrelStartY);
      ctx.lineTo(barrelEndX, barrelEndY);
      ctx.stroke();

      // Petit embout blanc au bout du canon (rétro style)
      ctx.fillStyle = VGA_PALETTE.WHITE;
      ctx.fillRect(barrelEndX - 1, barrelEndY - 1, 2, 2);

      // === Jauge de vie miniature ===
      const barWidth = 16;
      const barHeight = 3;
      const barX = x - barWidth / 2;
      const barY = y - tankHeight - 9;

      const healthRatio = Math.max(0, tank.health / tank.maxHealth);

      // Fond de la jauge
      ctx.fillStyle = VGA_PALETTE.DARK_GRAY;
      ctx.fillRect(barX, barY, barWidth, barHeight);

      // Vie restante
      ctx.fillStyle = healthRatio > 0.4 ? VGA_PALETTE.GREEN : VGA_PALETTE.RED;
      ctx.fillRect(barX, barY, barWidth * healthRatio, barHeight);

      // Bordure
      ctx.strokeStyle = VGA_PALETTE.WHITE;
      ctx.lineWidth = 0.5;
      ctx.strokeRect(barX, barY, barWidth, barHeight);

      // === Nom du joueur (police rétro 12px monospace, couleur VGA du joueur) ===
      // Positionné au-dessus de la jauge de vie. Masqué dynamiquement pendant les tirs.
      if (showPlayerNames) {
        ctx.font = '12px monospace';
        ctx.fillStyle = color;
        ctx.textAlign = 'center';
        const nameY = y - tankHeight - 24;
        ctx.fillText(player.name, x, nameY);
      }
    }
  }
}

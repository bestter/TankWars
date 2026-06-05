/**
 * TankWars - TankManager
 *
 * Gestionnaire central des tanks et de leur état de combat.
 * Gère le spawn, la physique de chute après explosions, les dégâts et le rendu rétro.
 */

import type { Player } from '../../types/player';
import type { TerrainManager } from '../engine/Terrain';
import { VGA_PALETTE } from '../../types/game';
import type { WeaponId } from '../../types/weapon';
import { drawTankSprite } from '../rendering/tankSprite';

/** Surface Y at or below this offset from canvas bottom = no support (tank sinks). */
const BOTTOM_SUPPORT_MARGIN = 14;

/** Falling damage constants: pixels of downward travel per 1 HP of damage. */
const FALL_DAMAGE_LEVEL_HEIGHT_NORMAL = 2; // normal/slope fall
const FALL_DAMAGE_LEVEL_HEIGHT_VOID = 1;   // void fall (accelerated damage)

/** Falling gravity constants. */
const TANK_GRAVITY_NORMAL = 850; // px/s² — original/slope gravity
const TANK_GRAVITY_VOID = 1200;   // px/s² — accelerated gravity for void fall

/** Falling terminal velocity constants. */
const TERMINAL_V_NORMAL = 16.0;  // original terminal velocity
const TERMINAL_V_VOID = 24.0;    // accelerated terminal velocity for void fall

/** Vertical gap threshold (in pixels) to distinguish falling in the void from sliding down a slope. */
const VOID_FALL_THRESHOLD = 12;

export class TankManager {
  private players: Player[] = [];

  /** Internal velocities for gradual falling (key = tank.id). Enables sliding + floor sounds. */
  private velocities: Map<string, number> = new Map();

  /** Accumulated downward distance per tank while falling. Used to apply "1 damage per level". */
  private fallenDistances: Map<string, number> = new Map();

  /** Map to track if a tank is falling in the void (versus sliding down a slope). */
  private isVoidFall: Map<string, boolean> = new Map();

  /** Transient per-tank recoil state for micro visual kick on fire (Step 4 arcade polish).
   *  Keyed by tank.id. Decayed in physics update; applied only to sprite draw pos.
   */
  private recoilState: Map<string, { dx: number; dy: number; remaining: number }> = new Map();

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
    this.isVoidFall.clear();
    this.recoilState.clear();
    for (const p of players) {
      this.velocities.set(p.tank.id, 0);
      this.fallenDistances.set(p.tank.id, 0);
    }
  }

  /** Clears fall velocities and fallen distance tracking (used on full match reset). */
  public clearVelocities(): void {
    this.velocities.clear();
    this.fallenDistances.clear();
    this.isVoidFall.clear();
    this.recoilState.clear();
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

      // Defaults for the new round (power + MISSILE as the always-available unlimited default)
      tank.power = 50;
      tank.currentWeapon = 'MISSILE';

      // Clear per-round AI revenge data
      tank.lastHitBy = undefined;
    });

    // Initialize velocities and fall tracking for new spawns
    this.velocities.clear();
    this.fallenDistances.clear();
    this.isVoidFall.clear();
    this.recoilState.clear();
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
        this.isVoidFall.set(id, true);
      } else if (tank.position.y + 0.5 < groundY) {
        // Normal crater under tank: give kick so it falls gradually (was instant before)
        if ((this.velocities.get(id) ?? 0) <= 0) {
          this.fallenDistances.set(id, 0);
        }
        const cur = this.velocities.get(id) ?? 0;
        this.velocities.set(id, Math.max(cur + 2.5, 3.5));

        // Determine if falling in the void based on height gap
        const gap = groundY - tank.position.y;
        this.isVoidFall.set(id, gap >= VOID_FALL_THRESHOLD);
      } else {
        // Resting or very close: snap exactly + zero vel (prevents float)
        if (Math.abs(tank.position.y - groundY) < 3) {
          tank.position.y = groundY;
          this.velocities.set(id, 0);
        }
        this.isVoidFall.set(id, false);
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
    const pitFloorY = terrain.height - BOTTOM_SUPPORT_MARGIN;

    for (const player of this.players) {
      const tank = player.tank;
      if (tank.isDead) {
        this.velocities.delete(tank.id);
        this.fallenDistances.delete(tank.id);
        this.isVoidFall.delete(tank.id);
        continue;
      }

      const id = tank.id;
      let vy = this.velocities.get(id) ?? 0;

      const groundY = terrain.getHeightAt(tank.position.x);
      const inPit = groundY >= pitFloorY || tank.position.y > pitFloorY;

      if (tank.position.y < groundY || inPit) {
        // Falling (normal crater or pit)
        // Initialize void fall flag if not already set
        if (!this.isVoidFall.has(id)) {
          const gap = groundY - tank.position.y;
          this.isVoidFall.set(id, gap >= VOID_FALL_THRESHOLD || inPit);
        }
        const isVoid = this.isVoidFall.get(id) ?? false;

        const gravity = isVoid ? TANK_GRAVITY_VOID : TANK_GRAVITY_NORMAL;
        const terminalV = isVoid ? TERMINAL_V_VOID : TERMINAL_V_NORMAL;
        const damageLevelHeight = isVoid ? FALL_DAMAGE_LEVEL_HEIGHT_VOID : FALL_DAMAGE_LEVEL_HEIGHT_NORMAL;

        vy = Math.min(vy + gravity * dt, terminalV);
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
          this.isVoidFall.delete(id);
          continue; // stop processing this tank for the frame
        }

        // === Fall damage: 1 point per damageLevelHeight pixels of downward travel ===
        const deltaFall = tank.position.y - prevY;
        if (deltaFall > 0) {
          let fallen = (this.fallenDistances.get(id) ?? 0) + deltaFall;
          this.fallenDistances.set(id, fallen);

          const levelsCrossed = Math.floor(fallen / damageLevelHeight);
          if (levelsCrossed > 0) {
            const dmg = levelsCrossed; // 1 per level
            const healthBefore = tank.health;
            tank.health = Math.max(0, tank.health - dmg);

            // keep remainder so we don't lose fractional progress
            fallen -= levelsCrossed * damageLevelHeight;
            this.fallenDistances.set(id, fallen);

            console.log(
              `[FALL DMG] ${player.name} ${isVoid ? '(VOID)' : '(SLOPE)'} +${deltaFall.toFixed(1)}px (accum ${(fallen + levelsCrossed * damageLevelHeight).toFixed(1)}) -> ${dmg} dmg, health=${tank.health}`
            );

            if (healthBefore > 0 && tank.health <= 0) {
              tank.isDead = true;
              const totalFallen = (fallen + levelsCrossed * damageLevelHeight).toFixed(0);
              const details = `fall damage (${dmg} pts after ~${totalFallen}px)`;
              console.log(
                `[DEATH] player=${player.name} (id=${player.id}) cause=burial (fall) pos=(${tank.position.x.toFixed(1)},${tank.position.y.toFixed(1)})`
              );
              this.onPlayerDied?.(player.id, 'burial', details);
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
        this.isVoidFall.set(id, false);
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
   * Check if a projectile point (x, y) is inside any alive tank's visual bounding box.
   * This implements direct "touch or fly into a tank" collisions so the shell explodes
   * immediately (per weapon rules: blast radius, damage, special kill zones, etc.)
   * instead of only triggering on terrain.
   */
  public checkTankCollision(x: number, y: number): boolean {
    const tankWidth = 24;
    const tankHeight = 15;

    for (const player of this.players) {
      const tank = player.tank;
      if (tank.isDead) continue;

      const { x: tx, y: ty } = tank.position;
      if (
        x >= tx - tankWidth / 2 &&
        x <= tx + tankWidth / 2 &&
        y >= ty - tankHeight &&
        y <= ty
      ) {
        return true;
      }
    }
    return false;
  }

  /**
   * Applique des dégâts d'explosion avec atténuation linéaire selon la distance.
   * Les dégâts sont d'abord absorbés par le bouclier, puis par la vie.
   * Special cases:
   * - weaponId === 'NUKE' && dist <=10 : direct hit instant kill.
   * - weaponId === 'THERMONUCLEAR' && dist <=75 : full inner kill zone (all tanks destroyed).
   *   Outer splash + the massive crater (blastRadius 160) will cause realistic falls for survivors
   *   (reuses existing applyGravity + fall damage + lava death).
   * @param killerId - Optional shooter id (for round-end kill attribution; splash counts for the explosion's firer)
   * @param weaponId - Optional weapon for special direct-hit / kill-zone rules
   * @returns Number of *new* kills caused by *this* explosion (for attribution to the killer)
   */
  public applyExplosionDamage(
    explosionX: number,
    explosionY: number,
    radius: number,
    maxDamage: number,
    killerId?: string,
    weaponId?: WeaponId,
  ): number {
    let killsThisExplosion = 0;

    for (const player of this.players) {
      const tank = player.tank;
      if (tank.isDead) continue;

      const dx = tank.position.x - explosionX;
      const dy = tank.position.y - explosionY;
      const distance = Math.sqrt(dx * dx + dy * dy);

      if (distance > radius) continue;

      const healthBefore = tank.health;

      // Dégâts dégressifs linéaires
      let damage = maxDamage * Math.max(0, 1 - distance / radius);

      // Nuke direct hit rule (per request): one direct hit kills the tank outright.
      // Threshold ~10px is slightly > tank half-extent (body 14px wide); near-center impact counts.
      if (weaponId === 'NUKE' && distance <= 10) {
        tank.shield = 0;
        tank.health = 0;
        damage = 0; // avoid double-subtract in the generic path below
      }

      // Thermonuclear inner kill zone (user request): all tanks within this distance are instantly destroyed
      // (the huge crater + outer splash + fall mechanics will handle "others might fall like actually").
      // 75px chosen as ~blastRadius * 0.47 for 160px thermo blast (tuneable; produces 1/4-map scale wipe + pit).
      if (weaponId === 'THERMONUCLEAR' && distance <= 75) {
        tank.shield = 0;
        tank.health = 0;
        damage = 0;
      }

      if (damage <= 0 && tank.health > 0) continue;

      // Bouclier en priorité (skipped or no-op for nuke direct which already zeroed)
      let remainingDamage = damage;

      if (tank.shield > 0) {
        const absorbed = Math.min(remainingDamage, tank.shield);
        tank.shield -= absorbed;
        remainingDamage -= absorbed;
      }

      if (remainingDamage > 0) {
        tank.health = Math.max(0, tank.health - remainingDamage);
      }

      // Record attacker for AI "revenge" targeting (even non-lethal hits). Cleared on round respawn.
      if (healthBefore > tank.health && killerId) {
        tank.lastHitBy = killerId;
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
  public draw(
    ctx: CanvasRenderingContext2D,
    showPlayerNames: boolean = true,
    terrain?: TerrainManager
  ): void {
    const tankWidth = 24;
    const tankHeight = 15;

    for (const player of this.players) {
      const tank = player.tank;
      if (tank.isDead) continue;

      const { x, y } = tank.position;
      const color = tank.color;

      // Calcul dynamique de l'angle du châssis en fonction de la pente du terrain
      let hullAngle = 0;
      if (terrain) {
        const checkDist = 6;
        const yLeft = terrain.getHeightAt(x - checkDist);
        const yRight = terrain.getHeightAt(x + checkDist);
        const dx = checkDist * 2;
        const dy = yRight - yLeft;
        const rawAngleRad = Math.atan2(dy, dx);
        const maxTiltDeg = 35; // inclinaison max pour garder le rendu propre
        hullAngle = Math.max(-maxTiltDeg, Math.min(maxTiltDeg, (rawAngleRad * 180) / Math.PI));
      }

      // Apply transient recoil offset (only to chassis sprite for "kick" feel; bars/names stay anchored)
      let spriteX = x;
      let spriteY = y - 8;
      const rec = this.recoilState.get(tank.id);
      if (rec) {
        spriteX += rec.dx;
        spriteY += rec.dy;
      }

      // Dessine le sprite de tank détaillé de l'Étape 1
      // Pivot à y - 8 pour caler exactement le bas des chenilles sur y (niveau du sol)
      // Conversion de l'angle du canon (degrés trigo) en coordonnées Canvas (-tank.angle)
      drawTankSprite(ctx, spriteX, spriteY, tankWidth, tankHeight, hullAngle, -tank.angle, color);

      // === Jauge de vie miniature ===
      const barWidth = 16;
      const barHeight = 3;
      const barX = x - barWidth / 2;
      const barY = y - 24; // au-dessus du dôme de la tourelle

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
      if (showPlayerNames) {
        ctx.font = '12px monospace';
        ctx.fillStyle = color;
        ctx.textAlign = 'center';
        const nameY = y - 34; // au-dessus de la jauge de vie
        ctx.fillText(player.name, x, nameY);
      }
    }
  }

  /**
   * Trigger a short visual recoil kick on the tank chassis (Step 4 arcade polish).
   * Called at fire time from GameEngine. Direction = opposite to barrel.
   * Offset is world-space pixels; applied during draw for the sprite only.
   */
  public triggerRecoil(tankId: string, angle: number): void {
    const rad = (angle * Math.PI) / 180;
    const dist = 2.8; // micro displacement (few pixels) — feels punchy at 120 Hz
    // Opposite to launch vector (cos for x, -sin for y in world). Recoil "pushes tank back".
    const dx = -Math.cos(rad) * dist;
    const dy = Math.sin(rad) * dist;
    this.recoilState.set(tankId, { dx, dy, remaining: 9 }); // ~75 ms at 120 Hz physics steps
  }

  /**
   * Decay active recoil states (called per physics dt in GameEngine.update).
   * Frame-counter based (no heavy time math or allocs per frame).
   */
  public decayRecoil(): void {
    // Collect to avoid any iterator mutation concerns (defensive, zero cost for N<=4)
    const toRemove: string[] = [];
    for (const [id, rec] of this.recoilState) {
      rec.remaining -= 1;
      if (rec.remaining <= 0) {
        toRemove.push(id);
      }
    }
    for (const id of toRemove) {
      this.recoilState.delete(id);
    }
  }

  /** Clear any active recoil (e.g. when entering SUMMARY/SHOP or new round). */
  public clearRecoil(): void {
    this.recoilState.clear();
  }
}

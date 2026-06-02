/**
 * TankWars - TankManager
 *
 * Gestionnaire central des tanks et de leur état de combat.
 * Gère le spawn, la physique de chute après explosions, les dégâts et le rendu rétro.
 */

import type { Player } from '../../types/player';
import type { TerrainManager } from '../engine/Terrain';
import { VGA_PALETTE } from '../../types/game';

export class TankManager {
  private players: Player[] = [];

  /** Debug hook: called when a player dies so GameEngine can accumulate causes for the final summary */
  public onPlayerDied?: (playerId: string, cause: 'explosion' | 'burial', details: string) => void;

  /** Remplace et prépare la liste des joueurs pour le combat */
  public setPlayers(players: Player[]): void {
    this.players = players;
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
    for (const player of this.players) {
      const tank = player.tank;
      if (tank.isDead) continue;

      const groundY = terrain.getHeightAt(tank.position.x);
      // Snaps tank to the terrain surface (prevents getting stuck or falling behind under micro-smoothing/adjustments)
      tank.position.y = groundY;
    }
  }

  /**
   * Vérifie si des tanks sont enterrés sous le plancher ou tombés hors écran.
   * Si la position Y du tank dépasse le bas de l'écran de combat, le tank est considéré
   * comme battu/effondré.
   */
  public checkTankBurial(terrain: TerrainManager): void {
    for (const player of this.players) {
      const tank = player.tank;
      if (tank.isDead) continue;

      // Élimination uniquement si le tank est passé sous le bas de l'écran (chute hors carte).
      // Ne pas confondre avec un cratère profond : position.y suit la surface via updateTankPositions.
      if (tank.position.y > terrain.height + 8) {
        tank.isDead = true;
        const details = `y=${tank.position.y.toFixed(1)} > height=${terrain.height} (fallen off screen)`;
        console.log(
          `[DEATH] player=${player.name} (id=${player.id}) cause=burial/out-of-bounds pos=(${tank.position.x.toFixed(1)},${tank.position.y.toFixed(1)})`
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

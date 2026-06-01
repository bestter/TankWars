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

  /**
   * Place les tanks de manière équitable sur le terrain.
   * Ajuste précisément la position Y pour qu'ils reposent sur le sol.
   */
  public spawnTanks(players: Player[], terrain: TerrainManager): void {
    this.players = players;

    const count = players.length;
    if (count < 2 || count > 4) {
      console.warn('TankManager: recommended player count is between 2 and 4');
    }

    const margin = terrain.width * 0.13;
    const usableWidth = terrain.width - margin * 2;
    const step = count > 1 ? usableWidth / (count - 1) : 0;

    players.forEach((player, index) => {
      const tank = player.tank;

      // Répartition horizontale équitable
      const x = margin + step * index;

      // Ancrage vertical exact sur le terrain
      const groundY = terrain.getHeightAt(x);

      tank.position = { x, y: groundY };

      // Réinitialisation de l'état de combat
      tank.health = tank.maxHealth;
      tank.shield = tank.maxShield ?? Math.floor(tank.maxHealth * 0.4);
      tank.maxShield = tank.maxShield ?? Math.floor(tank.maxHealth * 0.4);
      tank.isDead = false;

      // Angle de départ par défaut (légèrement vers le haut)
      tank.angle = index < count / 2 ? -35 : 35;
    });
  }

  /**
   * Met à jour la position verticale des tanks après une explosion.
   * Les tanks tombent si le sol sous eux a été détruit.
   */
  public updateTankPositions(terrain: TerrainManager): void {
    for (const player of this.players) {
      const tank = player.tank;
      if (tank.isDead) continue;

      const groundY = terrain.getHeightAt(tank.position.x);

      // Si le sol s'est effondré sous le tank
      if (tank.position.y < groundY) {
        // Tomber / glisser jusqu'au nouveau niveau du sol
        tank.position.y = groundY;
      }
    }
  }

  /**
   * Applique des dégâts d'explosion avec atténuation linéaire selon la distance.
   * Les dégâts sont d'abord absorbés par le bouclier, puis par la vie.
   */
  public applyExplosionDamage(
    explosionX: number,
    explosionY: number,
    radius: number,
    maxDamage: number,
  ): void {
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

      if (tank.health <= 0) {
        tank.isDead = true;
      }
    }
  }

  /**
   * Rendu rétro des tanks (style VGA 16 couleurs).
   */
  public draw(ctx: CanvasRenderingContext2D): void {
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

      // === Tourelle / Canon ===
      const angleRad = (tank.angle * Math.PI) / 180;
      const barrelLength = 11;
      const barrelThickness = 2;

      const barrelEndX = x + Math.cos(angleRad) * barrelLength;
      const barrelEndY = y - tankHeight / 2 + Math.sin(angleRad) * barrelLength * -1; // Y inversé

      ctx.strokeStyle = VGA_PALETTE.DARK_GRAY;
      ctx.lineWidth = barrelThickness + 1;
      ctx.beginPath();
      ctx.moveTo(x, y - tankHeight / 2);
      ctx.lineTo(barrelEndX, barrelEndY);
      ctx.stroke();

      // Canon plus clair
      ctx.strokeStyle = color;
      ctx.lineWidth = barrelThickness;
      ctx.beginPath();
      ctx.moveTo(x, y - tankHeight / 2);
      ctx.lineTo(barrelEndX, barrelEndY);
      ctx.stroke();

      // === Jauge de vie miniature ===
      const barWidth = 16;
      const barHeight = 3;
      const barX = x - barWidth / 2;
      const barY = y - tankHeight - 7;

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
    }
  }
}

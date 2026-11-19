import { VGA_PALETTE } from "../../../types/game";
import { secureRandom } from "../../../utils/random";

const THERMO_COLORS: readonly string[] = [
  VGA_PALETTE.RED,
  VGA_PALETTE.YELLOW,
  VGA_PALETTE.DARK_RED,
  VGA_PALETTE.BROWN,
];

export interface ImpactExplosion {
  x: number;
  y: number;
  life: number;
  maxLife: number;
  size: number;
  color: string;
}

export interface ImpactExplosionsOptions {
  width: number;
  height: number;
}

/**
 * Explosions et flash plein écran pour les impacts thermonucléaires (#414).
 * Particules avancées à 120 Hz dans update(), flash décrémenté dans drawFlash().
 */
export class ImpactExplosions {
  private readonly width: number;
  private readonly height: number;
  private readonly explosions: ImpactExplosion[] = [];
  private thermoFlashLife = 0;

  constructor(options: ImpactExplosionsOptions) {
    this.width = options.width;
    this.height = options.height;
  }

  public get hasActiveVisuals(): boolean {
    return this.thermoFlashLife > 0 || this.explosions.length > 0;
  }

  /** Retourne la référence interne sans allocation ni copie. */
  public getExplosions(): ReadonlyArray<ImpactExplosion> {
    return this.explosions;
  }

  public spawnThermonuclear(x: number, y: number): void {
    this.thermoFlashLife = 13;
    for (let i = 0; i < 42; i++) {
      const spread = 38 + secureRandom() * 18;
      this.explosions.push({
        x: x + (secureRandom() - 0.5) * spread,
        y: y + (secureRandom() - 0.5) * (spread * 0.7),
        life: 42 + secureRandom() * 28,
        maxLife: 70,
        size: 2.5 + secureRandom() * 8.5,
        color: THERMO_COLORS[i % THERMO_COLORS.length],
      });
    }
  }

  public update(): void {
    if (this.explosions.length === 0) return;
    let write = 0;
    for (let read = 0; read < this.explosions.length; read++) {
      const p = this.explosions[read];
      p.life -= 1;
      if (p.life > 0) {
        if (p.life > p.maxLife * 0.5) {
          p.size = p.size * 1.012 + 0.04;
        }
        this.explosions[write++] = p;
      }
    }
    this.explosions.length = write;
  }

  public drawFlash(ctx: CanvasRenderingContext2D): void {
    if (this.thermoFlashLife <= 0) return;

    ctx.globalAlpha = 0.24;
    ctx.fillStyle = VGA_PALETTE.RED;
    ctx.fillRect(0, 0, this.width, this.height);
    ctx.globalAlpha = 1;
    this.thermoFlashLife -= 1;
  }

  public drawParticles(ctx: CanvasRenderingContext2D): void {
    if (this.explosions.length === 0) return;

    for (let i = 0; i < this.explosions.length; i++) {
      const p = this.explosions[i];
      const a = Math.max(0.08, p.life / p.maxLife);
      ctx.globalAlpha = a;
      ctx.fillStyle = p.color;
      const s = p.size;
      ctx.fillRect(p.x - s / 2, p.y - s / 2, s, s);

      if (s > 4) {
        ctx.globalAlpha = a * 0.32;
        ctx.fillRect(p.x - s * 0.9, p.y - s * 0.9, s * 1.8, s * 1.8);
      }
      if (s > 7) {
        ctx.globalAlpha = a * 0.15;
        ctx.fillRect(p.x - s * 1.35, p.y - s * 1.35, s * 2.7, s * 2.7);
      }
    }
    ctx.globalAlpha = 1;
  }

  public clear(): void {
    this.explosions.length = 0;
    this.thermoFlashLife = 0;
  }
}

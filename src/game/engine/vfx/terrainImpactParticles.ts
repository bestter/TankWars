import { VGA_PALETTE } from "../../../types/game";
import { TERRAIN_MATERIAL, type TerrainMaterial } from "../../../types/terrain";

const DIRT_PALETTE = [VGA_PALETTE.BROWN, VGA_PALETTE.GREEN] as const;
const SOFT_PALETTE = [VGA_PALETTE.YELLOW, VGA_PALETTE.BROWN] as const;
const ROCK_PALETTE = [VGA_PALETTE.DARK_GRAY, VGA_PALETTE.GRAY] as const;

export interface TerrainImpactParticle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
  size: 1 | 2;
  color: string;
  kind: "dust" | "grain" | "shard";
  material: TerrainMaterial;
}

/**
 * Particules VGA dédiées aux impacts terrain/puits (#184, #414).
 * Utilise uniquement son PRNG Mulberry32 privé (isolé du générateur partagé du jeu)
 * et progresse exclusivement lors de drawAndAdvance(ctx) pour préserver l'invariance multi-Hz.
 */
export class TerrainImpactParticles {
  private readonly particles: TerrainImpactParticle[] = [];
  private seed = 0x9e3779b9;

  public get hasParticles(): boolean {
    return this.particles.length > 0;
  }

  /** Retourne la référence interne sans allocation ni copie. */
  public getParticles(): ReadonlyArray<TerrainImpactParticle> {
    return this.particles;
  }

  public spawn(x: number, y: number, material: TerrainMaterial): void {
    if (material === TERRAIN_MATERIAL.DIRT) {
      for (let i = 0; i < 8; i++) {
        const angle = -Math.PI * (0.15 + 0.7 * (i / 7));
        const speed = 1.1 + this.nextRandom() * 1.4;
        const size: 1 | 2 = i % 2 === 0 ? 2 : 1;
        this.particles.push({
          x,
          y,
          vx: Math.cos(angle) * speed,
          vy: Math.sin(angle) * speed,
          life: 16,
          maxLife: 16,
          size,
          color: DIRT_PALETTE[i % DIRT_PALETTE.length],
          kind: "dust",
          material,
        });
      }
      return;
    }

    if (material === TERRAIN_MATERIAL.SOFT) {
      for (let i = 0; i < 12; i++) {
        const angle = -Math.PI * (0.12 + 0.76 * (i / 11));
        const speed = 1.2 + this.nextRandom() * 1.6;
        const size: 1 | 2 = i % 2 === 0 ? 2 : 1;
        this.particles.push({
          x,
          y,
          vx: Math.cos(angle) * speed,
          vy: Math.sin(angle) * speed,
          life: 24,
          maxLife: 24,
          size,
          color: SOFT_PALETTE[i % SOFT_PALETTE.length],
          kind: "dust",
          material,
        });
      }
      for (let i = 0; i < 6; i++) {
        const angle = -Math.PI * (0.2 + 0.6 * (i / 5));
        const speed = 1.5 + this.nextRandom() * 1.3;
        const size: 1 | 2 = i % 2 === 0 ? 1 : 2;
        this.particles.push({
          x,
          y,
          vx: Math.cos(angle) * speed,
          vy: Math.sin(angle) * speed,
          life: 24,
          maxLife: 24,
          size,
          color: SOFT_PALETTE[i % SOFT_PALETTE.length],
          kind: "grain",
          material,
        });
      }
      return;
    }

    for (let i = 0; i < 6; i++) {
      const angle = -Math.PI * (0.18 + 0.64 * (i / 5));
      const speed = 1.6 + this.nextRandom() * 1.5;
      const size: 1 | 2 = i % 2 === 0 ? 2 : 1;
      this.particles.push({
        x,
        y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        life: 12,
        maxLife: 12,
        size,
        color: ROCK_PALETTE[i % ROCK_PALETTE.length],
        kind: "shard",
        material: TERRAIN_MATERIAL.ROCK,
      });
    }
  }

  public drawAndAdvance(ctx: CanvasRenderingContext2D): void {
    if (this.particles.length === 0) return;

    let write = 0;
    for (let read = 0; read < this.particles.length; read++) {
      const p = this.particles[read];
      const alpha = Math.max(0.1, p.life / p.maxLife);
      ctx.globalAlpha = alpha;
      ctx.fillStyle = p.color;
      ctx.fillRect(Math.round(p.x), Math.round(p.y), p.size, p.size);

      p.x += p.vx;
      p.y += p.vy;
      if (p.kind === "grain") {
        p.vy += 0.24;
      } else if (p.kind === "shard") {
        p.vy += 0.14;
      } else {
        p.vx *= 0.94;
        p.vy = p.vy * 0.94 + 0.05;
      }
      p.life -= 1;

      if (p.life > 0) {
        this.particles[write++] = p;
      }
    }
    this.particles.length = write;
    ctx.globalAlpha = 1;
  }

  public clear(): void {
    // Préserver intentionnellement la séquence du PRNG privé entre les manches.
    this.particles.length = 0;
  }

  private nextRandom(): number {
    let t = (this.seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
}

import { VGA_PALETTE } from "../../../types/game";
import type { Player } from "../../../types/player";
import { secureRandom } from "../../../utils/random";

export const FIREWORKS_TICK_DT = 1 / 60;
export const MAX_FIREWORKS = 250;

const ROCKET_TRAIL_CAPACITY = 7;
const PARTICLE_TRAIL_CAPACITY = 3;

const INITIAL_FESTIVE_COLORS: readonly string[] = [
  VGA_PALETTE.ELECTRIC_CYAN,
  VGA_PALETTE.FLASH_GREEN,
  VGA_PALETTE.NEON_PINK,
  VGA_PALETTE.CYBER_YELLOW,
  VGA_PALETTE.FLUO_ORANGE,
  VGA_PALETTE.VOLT_PURPLE,
  VGA_PALETTE.CYAN,
  VGA_PALETTE.MAGENTA,
  VGA_PALETTE.YELLOW,
];

const FESTIVE_COLORS: readonly string[] = [
  VGA_PALETTE.ELECTRIC_CYAN,
  VGA_PALETTE.FLASH_GREEN,
  VGA_PALETTE.NEON_PINK,
  VGA_PALETTE.CYBER_YELLOW,
  VGA_PALETTE.FLUO_ORANGE,
  VGA_PALETTE.VOLT_PURPLE,
  VGA_PALETTE.CYAN,
  VGA_PALETTE.MAGENTA,
  VGA_PALETTE.YELLOW,
  VGA_PALETTE.GREEN,
  VGA_PALETTE.BLUE,
  VGA_PALETTE.WHITE,
];

export interface RocketTrailRing {
  readonly capacity: typeof ROCKET_TRAIL_CAPACITY;
  readonly xs: Float64Array;
  readonly ys: Float64Array;
  readonly alphas: Float64Array;
  head: number;
  count: number;
}

export interface ParticleTrailRing {
  readonly capacity: typeof PARTICLE_TRAIL_CAPACITY;
  readonly xs: Float64Array;
  readonly ys: Float64Array;
  head: number;
  count: number;
}

export interface RocketFireworkParticle {
  type: "rocket";
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
  color: string;
  size: number;
  trail: RocketTrailRing;
}

export interface BurstFireworkParticle {
  type: "particle";
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
  color: string;
  size: number;
  trail: ParticleTrailRing;
}

export interface ConfettiFireworkParticle {
  type: "confetti";
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
  color: string;
  size: number;
  swaySpeed: number;
  swayOffset: number;
  swayWidth: number;
  rotation: number;
  rotationSpeed: number;
}

export type FireworkParticle =
  | RocketFireworkParticle
  | BurstFireworkParticle
  | ConfettiFireworkParticle;

export interface CelebrationFireworksOptions {
  width: number;
  height: number;
  getGroundHeight: (x: number) => number;
  onBurst: (x: number) => void;
}

export interface CannonOverride {
  player: Player;
  angle: number;
}

export interface CelebrationFireworksState {
  centerX: number;
  color: string;
  winner: Player | null;
  angle: number;
  angleDir: 1 | -1;
  updateAccum: number;
}

function createRocketTrailRing(): RocketTrailRing {
  return {
    capacity: ROCKET_TRAIL_CAPACITY,
    xs: new Float64Array(ROCKET_TRAIL_CAPACITY),
    ys: new Float64Array(ROCKET_TRAIL_CAPACITY),
    alphas: new Float64Array(ROCKET_TRAIL_CAPACITY),
    head: 0,
    count: 0,
  };
}

function createParticleTrailRing(): ParticleTrailRing {
  return {
    capacity: PARTICLE_TRAIL_CAPACITY,
    xs: new Float64Array(PARTICLE_TRAIL_CAPACITY),
    ys: new Float64Array(PARTICLE_TRAIL_CAPACITY),
    head: 0,
    count: 0,
  };
}

function pushRocketTrail(ring: RocketTrailRing, x: number, y: number): void {
  if (ring.count < ROCKET_TRAIL_CAPACITY) {
    const slot = (ring.head + ring.count) % ROCKET_TRAIL_CAPACITY;
    ring.xs[slot] = x;
    ring.ys[slot] = y;
    ring.alphas[slot] = 1.0;
    ring.count += 1;
  } else {
    ring.xs[ring.head] = x;
    ring.ys[ring.head] = y;
    ring.alphas[ring.head] = 1.0;
    ring.head = (ring.head + 1) % ROCKET_TRAIL_CAPACITY;
  }

  for (let i = 0; i < ring.count; i++) {
    const slot = (ring.head + i) % ROCKET_TRAIL_CAPACITY;
    ring.alphas[slot] -= 0.12;
  }
}

function pushParticleTrail(ring: ParticleTrailRing, x: number, y: number): void {
  if (ring.count < PARTICLE_TRAIL_CAPACITY) {
    const slot = (ring.head + ring.count) % PARTICLE_TRAIL_CAPACITY;
    ring.xs[slot] = x;
    ring.ys[slot] = y;
    ring.count += 1;
  } else {
    ring.xs[ring.head] = x;
    ring.ys[ring.head] = y;
    ring.head = (ring.head + 1) % PARTICLE_TRAIL_CAPACITY;
  }
}

export class CelebrationFireworks {
  private readonly width: number;
  private readonly height: number;
  private readonly getGroundHeight: (x: number) => number;
  private readonly onBurst: (x: number) => void;

  private readonly fireworks: FireworkParticle[] = [];
  private readonly spawnBuffer: FireworkParticle[] = [];
  private fireworksUpdateAccum = 0;

  private celebrationCenterX = 0;
  private celebrationColor = "#FFFFFF";
  private winner: Player | null = null;
  private angle = 90;
  private angleDir: 1 | -1 = 1;

  constructor(options: CelebrationFireworksOptions) {
    this.width = options.width;
    this.height = options.height;
    this.getGroundHeight = options.getGroundHeight;
    this.onBurst = options.onBurst;
  }

  public get hasParticles(): boolean {
    return this.fireworks.length > 0;
  }

  public getParticles(): ReadonlyArray<FireworkParticle> {
    return this.fireworks;
  }

  public getCannonOverride(): CannonOverride | null {
    if (this.winner === null) return null;
    return { player: this.winner, angle: this.angle };
  }

  public getCelebrationState(): Readonly<CelebrationFireworksState> {
    return {
      centerX: this.celebrationCenterX,
      color: this.celebrationColor,
      winner: this.winner,
      angle: this.angle,
      angleDir: this.angleDir,
      updateAccum: this.fireworksUpdateAccum,
    };
  }

  /** Démarre une célébration de feux d'artifice et d'éventuel balayage du canon vainqueur. */
  public start(
    centerX: number,
    centerY: number,
    color: string,
    winner: Player | null,
  ): void {
    this.fireworks.length = 0;
    this.spawnBuffer.length = 0;
    this.celebrationCenterX = centerX;
    this.celebrationColor = color;
    if (winner !== null) {
      this.winner = winner;
      this.angle = 78.5;
      this.angleDir = 1;
    } else {
      this.winner = null;
      this.angle = 90;
      this.angleDir = 1;
    }

    for (let i = 0; i < 9; i++) {
      const rocketColor =
        secureRandom() < 0.4
          ? this.celebrationColor
          : INITIAL_FESTIVE_COLORS[i % INITIAL_FESTIVE_COLORS.length];
      this.fireworks.push({
        type: "rocket",
        x: centerX + (secureRandom() - 0.5) * 180,
        y: this.height - 20,
        vx: (secureRandom() - 0.5) * 2.5,
        vy: -5.8 - secureRandom() * 3.2,
        life: 42 + secureRandom() * 26,
        maxLife: 68,
        color: rocketColor,
        size: 3.5 + secureRandom() * 2.0,
        trail: createRocketTrailRing(),
      });
    }

    for (let i = 0; i < 32; i++) {
      this.fireworks.push({
        type: "confetti",
        x: secureRandom() * this.width,
        y: secureRandom() * Math.max(80, centerY),
        vx: (secureRandom() - 0.5) * 1.2,
        vy: 0.2 + secureRandom() * 0.6,
        life: 120 + secureRandom() * 100,
        maxLife: 220,
        color: INITIAL_FESTIVE_COLORS[i % INITIAL_FESTIVE_COLORS.length],
        size: 4.0 + secureRandom() * 4.0,
        swaySpeed: 0.03 + secureRandom() * 0.04,
        swayOffset: secureRandom() * Math.PI * 2,
        swayWidth: 1.2 + secureRandom() * 1.8,
        rotation: secureRandom() * Math.PI * 2,
        rotationSpeed: (secureRandom() - 0.5) * 0.12,
      });
    }
  }

  public update(dt: number): void {
    this.fireworksUpdateAccum += dt;
    if (this.fireworksUpdateAccum < FIREWORKS_TICK_DT) return;
    this.fireworksUpdateAccum -= FIREWORKS_TICK_DT;

    this.tick();
  }

  public draw(ctx: CanvasRenderingContext2D): void {
    if (this.fireworks.length === 0) return;

    for (let i = 0; i < this.fireworks.length; i++) {
      const p = this.fireworks[i];
      const alpha = Math.max(0.1, p.life / p.maxLife);
      ctx.fillStyle = p.color;

      if (p.type === "rocket") {
        const trail = p.trail;
        if (trail.count > 0) {
          const halfStep = p.size / 3;
          const trailSize = p.size / 1.5;
          for (let j = 0; j < trail.count; j++) {
            const slot = (trail.head + j) % ROCKET_TRAIL_CAPACITY;
            ctx.globalAlpha = trail.alphas[slot] * alpha * 0.38;
            ctx.fillRect(
              trail.xs[slot] - halfStep,
              trail.ys[slot] - halfStep,
              trailSize,
              trailSize,
            );
          }
        }
        ctx.globalAlpha = alpha;
        const s = p.size;
        ctx.fillRect(p.x - s / 2, p.y - s / 2, s, s);
        if (s > 3.0) {
          ctx.globalAlpha = alpha * 0.28;
          ctx.fillRect(p.x - s, p.y - s, s * 2, s * 2);
        }
      } else if (p.type === "particle") {
        const trail = p.trail;
        if (trail.count > 0) {
          const halfStep = p.size / 3;
          const trailSize = p.size / 1.5;
          ctx.globalAlpha = alpha * 0.38;
          for (let j = 0; j < trail.count; j++) {
            const slot = (trail.head + j) % PARTICLE_TRAIL_CAPACITY;
            ctx.fillRect(
              trail.xs[slot] - halfStep,
              trail.ys[slot] - halfStep,
              trailSize,
              trailSize,
            );
          }
        }
        ctx.globalAlpha = alpha;
        const s = p.size;
        ctx.fillRect(p.x - s / 2, p.y - s / 2, s, s);
        if (s > 3.0) {
          ctx.globalAlpha = alpha * 0.28;
          ctx.fillRect(p.x - s, p.y - s, s * 2, s * 2);
        }
      } else {
        ctx.globalAlpha = alpha;
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rotation);
        ctx.fillRect(-p.size / 2, -p.size / 4, p.size, p.size / 2);
        ctx.restore();
      }
    }
    ctx.globalAlpha = 1.0;
  }

  public clear(): void {
    // Préserver le demi-pas accumulé pour conserver la cadence entre les manches.
    this.fireworks.length = 0;
    this.spawnBuffer.length = 0;
    this.celebrationCenterX = 0;
    this.celebrationColor = "#FFFFFF";
    this.winner = null;
    this.angle = 90;
    this.angleDir = 1;
  }

  private queueSpawn(p: FireworkParticle): void {
    if (this.fireworks.length + this.spawnBuffer.length < MAX_FIREWORKS) {
      this.spawnBuffer.push(p);
    }
  }

  private flushSpawns(): { rockets: number; confetti: number } {
    let rockets = 0;
    let confetti = 0;
    for (let i = 0; i < this.spawnBuffer.length; i++) {
      if (this.fireworks.length >= MAX_FIREWORKS) break;
      const spawn = this.spawnBuffer[i];
      this.fireworks.push(spawn);
      if (spawn.type === "rocket") rockets += 1;
      else if (spawn.type === "confetti") confetti += 1;
    }
    this.spawnBuffer.length = 0;
    return { rockets, confetti };
  }

  private tick(): void {
    if (this.winner !== null) {
      const angleStep = 1.0;
      this.angle += this.angleDir * angleStep;
      if (this.angle > 112.5) {
        this.angle = 112.5;
        this.angleDir = -1;
      } else if (this.angle < 78.5) {
        this.angle = 78.5;
        this.angleDir = 1;
      }

      if (secureRandom() < 0.18) {
        const tank = this.winner.tank;
        const barrelLength = 20;
        const rad = (this.angle * Math.PI) / 180;
        const barrelStartY = tank.position.y - 13;
        const tipX = tank.position.x + Math.cos(rad) * barrelLength;
        const tipY = barrelStartY + Math.sin(rad) * barrelLength * -1;
        const speed = 4.2 + secureRandom() * 2.8;
        const spread = (secureRandom() - 0.5) * 0.8;
        this.queueSpawn({
          type: "rocket",
          x: tipX,
          y: tipY,
          vx: Math.cos(rad) * speed + spread,
          vy: -Math.sin(rad) * speed - 0.8 + spread * 0.4,
          life: 35 + secureRandom() * 20,
          maxLife: 55,
          color: this.celebrationColor,
          size: 2.5 + secureRandom() * 1.5,
          trail: createRocketTrailRing(),
        });
      }
    }

    if (this.fireworks.length === 0 && this.spawnBuffer.length === 0) {
      return;
    }

    let write = 0;
    let activeRockets = 0;
    let activeConfetti = 0;

    for (let read = 0; read < this.fireworks.length; read++) {
      const p = this.fireworks[read];
      p.x += p.vx;
      p.y += p.vy;

      if (p.type === "rocket") {
        p.vy += 0.045;
        p.life -= 1;

        pushRocketTrail(p.trail, p.x, p.y);

        if (secureRandom() < 0.22) {
          this.queueSpawn({
            type: "particle",
            x: p.x - p.vx * 0.5,
            y: p.y - p.vy * 0.5,
            vx: (secureRandom() - 0.5) * 0.5,
            vy: 0.2 + secureRandom() * 0.6,
            life: 8 + secureRandom() * 8,
            maxLife: 16,
            color:
              secureRandom() < 0.5
                ? VGA_PALETTE.CYBER_YELLOW
                : VGA_PALETTE.WHITE,
            size: 1.2 + secureRandom() * 0.8,
            trail: createParticleTrailRing(),
          });
        }

        if (p.life <= 0) {
          // Appel audio conservé juste avant le choix du motif pour préserver l'ordre exact des tirages RNG.
          this.onBurst(p.x);

          const explosionPattern = Math.floor(secureRandom() * 4);

          if (explosionPattern === 0) {
            const count = 22 + Math.floor(secureRandom() * 10);
            const baseSpeed = 2.4 + secureRandom() * 1.6;
            const burstColor =
              secureRandom() < 0.4
                ? FESTIVE_COLORS[
                    Math.floor(secureRandom() * FESTIVE_COLORS.length)
                  ]
                : p.color;
            for (let i = 0; i < count; i++) {
              const angle = (i * 2 * Math.PI) / count;
              this.queueSpawn({
                type: "particle",
                x: p.x,
                y: p.y,
                vx: Math.cos(angle) * baseSpeed + (secureRandom() - 0.5) * 0.3,
                vy: Math.sin(angle) * baseSpeed + (secureRandom() - 0.5) * 0.3,
                life: 25 + secureRandom() * 18,
                maxLife: 43,
                color: burstColor,
                size: 2.0 + secureRandom() * 1.8,
                trail: createParticleTrailRing(),
              });
            }
          } else if (explosionPattern === 1) {
            const count = 28 + Math.floor(secureRandom() * 12);
            for (let i = 0; i < count; i++) {
              const angle = secureRandom() * Math.PI * 2;
              const speed = 1.0 + secureRandom() * 3.8;
              this.queueSpawn({
                type: "particle",
                x: p.x,
                y: p.y,
                vx: Math.cos(angle) * speed,
                vy: Math.sin(angle) * speed,
                life: 20 + secureRandom() * 22,
                maxLife: 42,
                color:
                  FESTIVE_COLORS[
                    Math.floor(secureRandom() * FESTIVE_COLORS.length)
                  ],
                size: 1.8 + secureRandom() * 2.2,
                trail: createParticleTrailRing(),
              });
            }
          } else if (explosionPattern === 2) {
            const count = 18 + Math.floor(secureRandom() * 10);
            const burstColor =
              secureRandom() < 0.3 ? VGA_PALETTE.CYBER_YELLOW : p.color;
            for (let i = 0; i < count; i++) {
              this.queueSpawn({
                type: "particle",
                x: p.x,
                y: p.y,
                vx: (secureRandom() - 0.5) * 2.2,
                vy: -2.0 - secureRandom() * 3.5,
                life: 30 + secureRandom() * 25,
                maxLife: 55,
                color: burstColor,
                size: 1.5 + secureRandom() * 1.5,
                trail: createParticleTrailRing(),
              });
            }
          } else {
            const count = 24 + Math.floor(secureRandom() * 8);
            for (let i = 0; i < count; i++) {
              const angle = secureRandom() * Math.PI * 2;
              const speed = 1.8 + secureRandom() * 2.8;
              this.queueSpawn({
                type: "particle",
                x: p.x,
                y: p.y,
                vx: Math.cos(angle) * speed,
                vy: Math.sin(angle) * speed - 0.4,
                life: 28 + secureRandom() * 22,
                maxLife: 50,
                color:
                  secureRandom() < 0.5
                    ? VGA_PALETTE.CYBER_YELLOW
                    : VGA_PALETTE.WHITE,
                size: 1.5 + secureRandom() * 1.0,
                trail: createParticleTrailRing(),
              });
            }
          }

          const confettiCount = 6 + Math.floor(secureRandom() * 6);
          for (let i = 0; i < confettiCount; i++) {
            this.queueSpawn({
              type: "confetti",
              x: p.x,
              y: p.y,
              vx: (secureRandom() - 0.5) * 3.5,
              vy: -1.0 - secureRandom() * 2.0,
              life: 110 + secureRandom() * 80,
              maxLife: 190,
              color:
                FESTIVE_COLORS[
                  Math.floor(secureRandom() * FESTIVE_COLORS.length)
                ],
              size: 4 + secureRandom() * 4,
              swaySpeed: 0.04 + secureRandom() * 0.05,
              swayOffset: secureRandom() * Math.PI * 2,
              swayWidth: 1.2 + secureRandom() * 1.8,
              rotation: secureRandom() * Math.PI * 2,
              rotationSpeed: (secureRandom() - 0.5) * 0.15,
            });
          }
        } else {
          this.fireworks[write++] = p;
          activeRockets += 1;
        }
      } else if (p.type === "particle") {
        p.vy += 0.075;
        p.vx *= 0.95;
        p.vy *= 0.95;
        p.life -= 1;

        pushParticleTrail(p.trail, p.x, p.y);

        if (p.life < 8) {
          p.size *= 0.82;
        }

        if (p.life > 0) {
          this.fireworks[write++] = p;
        }
      } else {
        p.vy = Math.min(1.0, p.vy + 0.025);
        p.vx = Math.sin(p.life * p.swaySpeed + p.swayOffset) * p.swayWidth;
        p.rotation += p.rotationSpeed;
        p.life -= 1;

        const groundY = this.getGroundHeight(
          Math.max(0, Math.min(this.width - 1, Math.floor(p.x))),
        );

        if (p.life > 0 && p.y < groundY) {
          this.fireworks[write++] = p;
          activeConfetti += 1;
        }
      }
    }

    this.fireworks.length = write;
    const flushed = this.flushSpawns();
    activeRockets += flushed.rockets;
    activeConfetti += flushed.confetti;

    if (activeRockets < 5 && secureRandom() < 0.07) {
      const spawnX = Math.max(
        40,
        Math.min(
          this.width - 40,
          this.celebrationCenterX + (secureRandom() - 0.5) * 260,
        ),
      );
      const spawnColor =
        FESTIVE_COLORS[Math.floor(secureRandom() * FESTIVE_COLORS.length)];
      this.queueSpawn({
        type: "rocket",
        x: spawnX,
        y: this.height - 15,
        vx: (secureRandom() - 0.5) * 1.8,
        vy: -5.5 - secureRandom() * 3.0,
        life: 45 + secureRandom() * 22,
        maxLife: 67,
        color: spawnColor,
        size: 3.5 + secureRandom() * 2.0,
        trail: createRocketTrailRing(),
      });
    }

    if (activeConfetti < 40 && secureRandom() < 0.15) {
      this.queueSpawn({
        type: "confetti",
        x: secureRandom() * this.width,
        y: -10,
        vx: (secureRandom() - 0.5) * 1.0,
        vy: 0.3 + secureRandom() * 0.5,
        life: 130 + secureRandom() * 90,
        maxLife: 220,
        color:
          FESTIVE_COLORS[Math.floor(secureRandom() * FESTIVE_COLORS.length)],
        size: 4 + secureRandom() * 3.5,
        swaySpeed: 0.03 + secureRandom() * 0.04,
        swayOffset: secureRandom() * Math.PI * 2,
        swayWidth: 1.0 + secureRandom() * 1.8,
        rotation: secureRandom() * Math.PI * 2,
        rotationSpeed: (secureRandom() - 0.5) * 0.1,
      });
    }

    this.flushSpawns();
  }
}

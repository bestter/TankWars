import { VGA_PALETTE } from "../../../types/game";
import type { Player } from "../../../types/player";
import { secureRandom } from "../../../utils/random";

export const FIREWORKS_TICK_DT = 1 / 60;
export const MAX_FIREWORKS = 250;

const ROCKET_TRAIL_CAPACITY = 7;
const PARTICLE_TRAIL_CAPACITY = 3;
const ROCKET_TRAIL_STRIDE = 3;
const PARTICLE_TRAIL_STRIDE = 2;

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

interface RocketTrailRing {
  readonly capacity: typeof ROCKET_TRAIL_CAPACITY;
  /** Tampon unique entrelacé `[x, y, alpha]` par emplacement (stride 3). */
  readonly data: Float64Array;
  head: number;
  count: number;
}

interface ParticleTrailRing {
  readonly capacity: typeof PARTICLE_TRAIL_CAPACITY;
  /** Tampon unique entrelacé `[x, y]` par emplacement (stride 2). */
  readonly data: Float64Array;
  head: number;
  count: number;
}

interface RocketFireworkParticle {
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

interface BurstFireworkParticle {
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

interface ConfettiFireworkParticle {
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

type FireworkParticle =
  | RocketFireworkParticle
  | BurstFireworkParticle
  | ConfettiFireworkParticle;

interface CelebrationFireworksOptions {
  width: number;
  height: number;
  getGroundHeight: (x: number) => number;
  onBurst: (x: number) => void;
}

interface CelebrationFireworksState {
  centerX: number;
  color: string;
  winner: Player | null;
  angle: number;
  angleDir: 1 | -1;
  updateAccum: number;
}

/**
 * Une seule allocation par traînée (taille fixe, réutilisée pendant toute la vie de la particule),
 * au lieu d'un objet par tick comme l'ancien `push`/`shift`.
 */
function createRocketTrailRing(): RocketTrailRing {
  return {
    capacity: ROCKET_TRAIL_CAPACITY,
    data: new Float64Array(ROCKET_TRAIL_CAPACITY * ROCKET_TRAIL_STRIDE),
    head: 0,
    count: 0,
  };
}

function createParticleTrailRing(): ParticleTrailRing {
  return {
    capacity: PARTICLE_TRAIL_CAPACITY,
    data: new Float64Array(PARTICLE_TRAIL_CAPACITY * PARTICLE_TRAIL_STRIDE),
    head: 0,
    count: 0,
  };
}

function pushRocketTrail(ring: RocketTrailRing, x: number, y: number): void {
  let slot: number;
  if (ring.count < ROCKET_TRAIL_CAPACITY) {
    slot = (ring.head + ring.count) % ROCKET_TRAIL_CAPACITY;
    ring.count += 1;
  } else {
    slot = ring.head;
    ring.head = (ring.head + 1) % ROCKET_TRAIL_CAPACITY;
  }
  const base = slot * ROCKET_TRAIL_STRIDE;
  ring.data[base] = x;
  ring.data[base + 1] = y;
  ring.data[base + 2] = 1.0;

  for (let i = 0; i < ring.count; i++) {
    const alphaIndex =
      ((ring.head + i) % ROCKET_TRAIL_CAPACITY) * ROCKET_TRAIL_STRIDE + 2;
    ring.data[alphaIndex] -= 0.12;
  }
}

function pushParticleTrail(ring: ParticleTrailRing, x: number, y: number): void {
  let slot: number;
  if (ring.count < PARTICLE_TRAIL_CAPACITY) {
    slot = (ring.head + ring.count) % PARTICLE_TRAIL_CAPACITY;
    ring.count += 1;
  } else {
    slot = ring.head;
    ring.head = (ring.head + 1) % PARTICLE_TRAIL_CAPACITY;
  }
  const base = slot * PARTICLE_TRAIL_STRIDE;
  ring.data[base] = x;
  ring.data[base + 1] = y;
}

/** Corps carré et halo communs aux fusées et aux éclats. */
function drawBodyWithGlow(
  ctx: CanvasRenderingContext2D,
  p: RocketFireworkParticle | BurstFireworkParticle,
  alpha: number,
): void {
  ctx.globalAlpha = alpha;
  const s = p.size;
  ctx.fillRect(p.x - s / 2, p.y - s / 2, s, s);
  if (s > 3.0) {
    ctx.globalAlpha = alpha * 0.28;
    ctx.fillRect(p.x - s, p.y - s, s * 2, s * 2);
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
  private flushedRockets = 0;
  private flushedConfetti = 0;

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

  /** Tank vainqueur dont le canon balaie pendant la célébration, sinon `null`. */
  public get cannonWinner(): Player | null {
    return this.winner;
  }

  /** Angle de balayage courant du canon vainqueur (degrés). */
  public get cannonAngle(): number {
    return this.angle;
  }

  /**
   * @internal Diagnostic réservé aux tests : alloue un instantané, ne pas appeler
   * depuis la boucle de rendu ou de simulation.
   */
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
            const base =
              ((trail.head + j) % ROCKET_TRAIL_CAPACITY) * ROCKET_TRAIL_STRIDE;
            ctx.globalAlpha = trail.data[base + 2] * alpha * 0.38;
            ctx.fillRect(
              trail.data[base] - halfStep,
              trail.data[base + 1] - halfStep,
              trailSize,
              trailSize,
            );
          }
        }
        drawBodyWithGlow(ctx, p, alpha);
      } else if (p.type === "particle") {
        const trail = p.trail;
        if (trail.count > 0) {
          const halfStep = p.size / 3;
          const trailSize = p.size / 1.5;
          ctx.globalAlpha = alpha * 0.38;
          for (let j = 0; j < trail.count; j++) {
            const base =
              ((trail.head + j) % PARTICLE_TRAIL_CAPACITY) *
              PARTICLE_TRAIL_STRIDE;
            ctx.fillRect(
              trail.data[base] - halfStep,
              trail.data[base + 1] - halfStep,
              trailSize,
              trailSize,
            );
          }
        }
        drawBodyWithGlow(ctx, p, alpha);
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

  /** Ajoute les apparitions en file et compte celles réellement ajoutées, sans allocation. */
  private flushSpawns(): void {
    this.flushedRockets = 0;
    this.flushedConfetti = 0;
    for (let i = 0; i < this.spawnBuffer.length; i++) {
      if (this.fireworks.length >= MAX_FIREWORKS) break;
      const spawn = this.spawnBuffer[i];
      this.fireworks.push(spawn);
      if (spawn.type === "rocket") this.flushedRockets += 1;
      else if (spawn.type === "confetti") this.flushedConfetti += 1;
    }
    this.spawnBuffer.length = 0;
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
    this.flushSpawns();
    activeRockets += this.flushedRockets;
    activeConfetti += this.flushedConfetti;

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

import { afterEach, describe, expect, it, vi } from "vitest";
import { PhysicsEngine } from "../PhysicsEngine";
import { TankManager } from "../../entities/TankManager";
import type { TerrainManager } from "../Terrain";
import { makePlayer, makeTank } from "../../__tests__/helpers";
import { VGA_PALETTE } from "../../../types/game";
import { TERRAIN_MATERIAL } from "../../../types/terrain";
import { WEAPON_REGISTRY } from "../../../types/weapon";
import * as random from "../../../utils/random";

interface RecordedArcOp {
  readonly op: "fill" | "stroke";
  readonly x: number;
  readonly y: number;
  readonly radius: number;
  readonly fillStyle: string;
  readonly strokeStyle: string;
  readonly lineWidth: number;
  readonly alpha: number;
}

interface RecordedRectOp {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly fillStyle: string;
  readonly alpha: number;
}

function createProjectileCanvasRecorder() {
  let fillStyle = "#000000";
  let strokeStyle = "#000000";
  let lineWidth = 1;
  let globalAlpha = 1;
  const stack: Array<{
    fillStyle: string;
    strokeStyle: string;
    lineWidth: number;
    globalAlpha: number;
  }> = [];
  let currentArc: { x: number; y: number; radius: number } | null = null;
  const arcs: RecordedArcOp[] = [];
  const rects: RecordedRectOp[] = [];

  const ctx = {
    get fillStyle(): string {
      return fillStyle;
    },
    set fillStyle(value: string) {
      fillStyle = value;
    },
    get strokeStyle(): string {
      return strokeStyle;
    },
    set strokeStyle(value: string) {
      strokeStyle = value;
    },
    get lineWidth(): number {
      return lineWidth;
    },
    set lineWidth(value: number) {
      lineWidth = value;
    },
    get globalAlpha(): number {
      return globalAlpha;
    },
    set globalAlpha(value: number) {
      globalAlpha = value;
    },
    save(): void {
      stack.push({ fillStyle, strokeStyle, lineWidth, globalAlpha });
    },
    restore(): void {
      const prev = stack.pop();
      if (prev) {
        fillStyle = prev.fillStyle;
        strokeStyle = prev.strokeStyle;
        lineWidth = prev.lineWidth;
        globalAlpha = prev.globalAlpha;
      }
    },
    beginPath(): void {
      currentArc = null;
    },
    arc(x: number, y: number, radius: number): void {
      currentArc = { x, y, radius };
    },
    fill(): void {
      if (!currentArc) return;
      arcs.push({
        op: "fill",
        x: currentArc.x,
        y: currentArc.y,
        radius: currentArc.radius,
        fillStyle,
        strokeStyle,
        lineWidth,
        alpha: globalAlpha,
      });
    },
    stroke(): void {
      if (!currentArc) return;
      arcs.push({
        op: "stroke",
        x: currentArc.x,
        y: currentArc.y,
        radius: currentArc.radius,
        fillStyle,
        strokeStyle,
        lineWidth,
        alpha: globalAlpha,
      });
    },
    fillRect(x: number, y: number, w: number, h: number): void {
      rects.push({ x, y, w, h, fillStyle, alpha: globalAlpha });
    },
  } as unknown as CanvasRenderingContext2D;

  return {
    ctx,
    arcs,
    rects,
    getGlobalAlpha: () => globalAlpha,
    reset(): void {
      arcs.length = 0;
      rects.length = 0;
    },
  };
}

function parseHexRgb(hex: string): { r: number; g: number; b: number } {
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!match) {
    throw new Error(`Couleur hexadécimale invalide : ${hex}`);
  }
  return {
    r: Number.parseInt(match[1], 16),
    g: Number.parseInt(match[2], 16),
    b: Number.parseInt(match[3], 16),
  };
}

function relativeLuminance(hex: string): number {
  const { r, g, b } = parseHexRgb(hex);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function findOpaqueBodyArc(arcs: readonly RecordedArcOp[]): RecordedArcOp {
  const body = arcs.find((arc) => arc.op === "fill" && arc.alpha === 1);
  if (!body) {
    throw new Error("Aucun corps opaque trouvé dans les opérations de dessin");
  }
  return body;
}

function mockTerrain(overrides: Partial<TerrainManager> = {}): TerrainManager {
  return {
    width: 800,
    height: 480,
    checkCollision: () => false,
    destroyTerrain: vi.fn(),
    destroyTerrainShaft: vi.fn(),
    getHeightAt: () => 400,
    getMaterialAt: () => TERRAIN_MATERIAL.DIRT,
    isBlastOccludedByRock: () => false,
    ...overrides,
  } as unknown as TerrainManager;
}

describe("PhysicsEngine nuclear projectile visuals & grazing collisions (#435)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("draws NUKE centered at 18 px diameter in pulsing scarlet red regardless of shooter color", () => {
    const secureRandomSpy = vi.spyOn(random, "secureRandom");
    const mathRandomSpy = vi.spyOn(Math, "random");

    const physics = new PhysicsEngine();
    physics.launchProjectile(240, 130, 45, 50, "NUKE", "p1", VGA_PALETTE.ELECTRIC_CYAN);
    const shell = physics.getProjectiles()[0];
    shell.x = 240.5;
    shell.y = 130.25;

    const lowRecorder = createProjectileCanvasRecorder();
    physics.draw(lowRecorder.ctx, 360); // sin(3pi/2) = -1 -> pulse 0

    const highRecorder = createProjectileCanvasRecorder();
    physics.draw(highRecorder.ctx, 120); // sin(pi/2) = +1 -> pulse 1

    const lowBody = findOpaqueBodyArc(lowRecorder.arcs);
    const highBody = findOpaqueBodyArc(highRecorder.arcs);

    // Center & diameter (18 px minimum, 2x CLUSTER parent 9 px)
    expect(lowBody.x).toBe(240.5);
    expect(lowBody.y).toBe(130.25);
    expect(lowBody.radius * 2).toBe(18);
    expect(highBody.x).toBe(240.5);
    expect(highBody.y).toBe(130.25);
    expect(highBody.radius * 2).toBe(18);

    // Scarlet red dominant at both phases, independent of shooter's cyan color
    for (const body of [lowBody, highBody]) {
      expect(body.fillStyle.toLowerCase()).not.toBe(VGA_PALETTE.ELECTRIC_CYAN.toLowerCase());
      const { r, g, b } = parseHexRgb(body.fillStyle);
      expect(r).toBeGreaterThanOrEqual(180);
      expect(r).toBeGreaterThan(g * 4);
      expect(r).toBeGreaterThan(b * 3);
    }

    // Gentle luminance pulse between trough and peak
    expect(relativeLuminance(highBody.fillStyle)).toBeGreaterThan(
      relativeLuminance(lowBody.fillStyle),
    );
    expect(lowBody.fillStyle).not.toBe(highBody.fillStyle);

    // Dark outline for light backgrounds and bright inner rim for dark backgrounds
    expect(
      lowRecorder.arcs.some(
        (arc) => arc.op === "stroke" && arc.radius === 9 && arc.strokeStyle === VGA_PALETTE.BLACK,
      ),
    ).toBe(true);
    expect(
      lowRecorder.arcs.some(
        (arc) => arc.op === "stroke" && arc.radius < 9 && arc.strokeStyle !== VGA_PALETTE.BLACK,
      ),
    ).toBe(true);

    // Canvas state restored & zero RNG draws
    expect(lowRecorder.getGlobalAlpha()).toBe(1);
    expect(highRecorder.getGlobalAlpha()).toBe(1);
    expect(secureRandomSpy).not.toHaveBeenCalled();
    expect(mathRandomSpy).not.toHaveBeenCalled();
  });

  it("draws THERMONUCLEAR centered at 36 px diameter in pulsing forest green regardless of shooter color", () => {
    const physics = new PhysicsEngine();
    physics.launchProjectile(310, 180, 60, 40, "THERMONUCLEAR", "p1", VGA_PALETTE.NEON_PINK);
    const shell = physics.getProjectiles()[0];
    shell.x = 310.75;
    shell.y = 180.5;

    const lowRecorder = createProjectileCanvasRecorder();
    physics.draw(lowRecorder.ctx, 510); // sin(3pi/2) = -1 -> pulse 0

    const highRecorder = createProjectileCanvasRecorder();
    physics.draw(highRecorder.ctx, 170); // sin(pi/2) = +1 -> pulse 1

    const lowBody = findOpaqueBodyArc(lowRecorder.arcs);
    const highBody = findOpaqueBodyArc(highRecorder.arcs);

    // Center & diameter (36 px minimum, 4x CLUSTER parent 9 px)
    expect(lowBody.x).toBe(310.75);
    expect(lowBody.y).toBe(180.5);
    expect(lowBody.radius * 2).toBe(36);
    expect(highBody.x).toBe(310.75);
    expect(highBody.y).toBe(180.5);
    expect(highBody.radius * 2).toBe(36);

    // Forest green dominant at both phases, independent of shooter's pink color
    for (const body of [lowBody, highBody]) {
      expect(body.fillStyle.toLowerCase()).not.toBe(VGA_PALETTE.NEON_PINK.toLowerCase());
      const { r, g, b } = parseHexRgb(body.fillStyle);
      expect(g).toBeGreaterThanOrEqual(85);
      expect(g).toBeLessThanOrEqual(160);
      expect(g).toBeGreaterThan(r * 3);
      expect(g).toBeGreaterThan(b * 2);
    }

    // Gentle luminance pulse between trough and peak
    expect(relativeLuminance(highBody.fillStyle)).toBeGreaterThan(
      relativeLuminance(lowBody.fillStyle),
    );
    expect(lowBody.fillStyle).not.toBe(highBody.fillStyle);

    // Contrast rims and clean alpha restoration
    expect(
      lowRecorder.arcs.some(
        (arc) => arc.op === "stroke" && arc.radius === 18 && arc.strokeStyle === VGA_PALETTE.BLACK,
      ),
    ).toBe(true);
    expect(
      lowRecorder.arcs.some(
        (arc) => arc.op === "stroke" && arc.radius < 18 && arc.strokeStyle !== VGA_PALETTE.BLACK,
      ),
    ).toBe(true);
    expect(lowRecorder.getGlobalAlpha()).toBe(1);
    expect(highRecorder.getGlobalAlpha()).toBe(1);
  });

  it("preserves CLUSTER parent (9 px), MISSILE (5 px), ownerColor inheritance, and registry colors as witnesses", () => {
    const physics = new PhysicsEngine();
    physics.launchProjectile(100, 100, 45, 50, "CLUSTER", "p1", VGA_PALETTE.CYBER_YELLOW);
    physics.launchProjectile(150, 100, 45, 50, "MISSILE", "p2", VGA_PALETTE.VOLT_PURPLE);

    const recorder = createProjectileCanvasRecorder();
    physics.draw(recorder.ctx, 120);

    expect(recorder.arcs).toHaveLength(2);
    const [clusterBody, missileBody] = recorder.arcs;
    expect(clusterBody).toMatchObject({
      op: "fill",
      x: 100,
      y: 100,
      radius: 4.5,
      fillStyle: VGA_PALETTE.CYBER_YELLOW,
      alpha: 1,
    });
    expect(missileBody).toMatchObject({
      op: "fill",
      x: 150,
      y: 100,
      radius: 2.5,
      fillStyle: VGA_PALETTE.VOLT_PURPLE,
      alpha: 1,
    });

    // Registry colors stay reserved to their VGA_PALETTE fallback
    expect(WEAPON_REGISTRY.NUKE.color).toBe(VGA_PALETTE.RED);
    expect(WEAPON_REGISTRY.THERMONUCLEAR.color).toBe(VGA_PALETTE.RED);
  });

  it.each([
    ["NUKE", 9],
    ["THERMONUCLEAR", 18],
  ] as const)(
    "does not trigger an early impact when the enlarged %s silhouette grazes terrain or a tank",
    (weaponId, visualRadius) => {
      const enemy = makePlayer({
        id: "enemy",
        tank: makeTank("t-enemy", 200, 200),
      });
      const tanks = new TankManager();
      tanks.setPlayers([enemy]);
      const hitSpy = vi.fn();
      const destroySpy = vi.fn();
      // Flat terrain at y = 200: point collision only when y >= 200
      const terrain = mockTerrain({
        checkCollision: (_x, y) => y >= 200,
        destroyTerrain: destroySpy,
        getHeightAt: () => 200,
      });

      const physics = new PhysicsEngine();
      physics.onProjectileHit = hitSpy;
      // Place center 4 px above enemy tank hitbox top (tank hitbox is y in [185, 200])
      // and well within visualRadius (9 px / 18 px) of both the tank and terrain.
      const grazingY = 181;
      expect(200 - grazingY).toBeGreaterThan(0);
      expect(185 - grazingY).toBeLessThan(visualRadius);

      physics.launchProjectile(190, grazingY, 0, 50, weaponId, "owner");
      const shell = physics.getProjectiles()[0];
      shell.vx = 60;
      shell.vy = 0;

      // Advance horizontally right above the enemy tank (grazing its top within visual radius)
      for (let step = 0; step < 30; step++) {
        physics.updateProjectiles(1 / 120, 0, 0, terrain, tanks);
      }

      expect(hitSpy).not.toHaveBeenCalled();
      expect(destroySpy).not.toHaveBeenCalled();
      expect(physics.count).toBe(1);

      // Moving the simulated center onto the terrain triggers the real impact
      physics.getProjectiles()[0].y = 200;
      physics.updateProjectiles(1 / 120, 0, 0, terrain, tanks);
      expect(hitSpy).toHaveBeenCalledTimes(1);
      expect(destroySpy).toHaveBeenCalledTimes(1);
      expect(physics.count).toBe(0);
    },
  );
});

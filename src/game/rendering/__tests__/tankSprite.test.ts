import { describe, it, expect, vi, beforeEach } from 'vitest';
import { drawTankSprite } from '../tankSprite';
import { VGA_PALETTE } from '../../../types/game';

describe('drawTankSprite', () => {
  let mockCtx: Record<string, unknown>;
  let fillStyleAssignments: string[];
  let strokeStyleAssignments: string[];

  beforeEach(() => {
    fillStyleAssignments = [];
    strokeStyleAssignments = [];

    // Create a mock CanvasRenderingContext2D with setters to track property assignments
    mockCtx = {
      save: vi.fn(),
      restore: vi.fn(),
      translate: vi.fn(),
      rotate: vi.fn(),
      fillRect: vi.fn(),
      strokeRect: vi.fn(),
      beginPath: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      closePath: vi.fn(),
      fill: vi.fn(),
      stroke: vi.fn(),
      arc: vi.fn(),
      lineWidth: 0,
      lineCap: '',
    };

    // Use Object.defineProperty to intercept assignments
    Object.defineProperty(mockCtx, 'fillStyle', {
      set: (val: string) => fillStyleAssignments.push(val),
      get: () => fillStyleAssignments[fillStyleAssignments.length - 1] || '',
      configurable: true
    });

    Object.defineProperty(mockCtx, 'strokeStyle', {
      set: (val: string) => strokeStyleAssignments.push(val),
      get: () => strokeStyleAssignments[strokeStyleAssignments.length - 1] || '',
      configurable: true
    });
  });

  it('draws a tank sprite without throwing errors', () => {
    expect(() => {
      drawTankSprite(
        mockCtx as unknown as CanvasRenderingContext2D,
        100, // x
        200, // y
        20,  // width
        15,  // height
        45,  // angle
        90,  // turretAngle
        VGA_PALETTE.RED // primaryColor
      );
    }).not.toThrow();
  });

  it('saves and restores the context state appropriately', () => {
    drawTankSprite(
      mockCtx as unknown as CanvasRenderingContext2D,
      100, 200, 20, 15, 0, 0, VGA_PALETTE.BLUE
    );

    // Once for main tank, once for turret, so 2 saves and 2 restores expected
    expect(mockCtx.save).toHaveBeenCalledTimes(2);
    expect(mockCtx.restore).toHaveBeenCalledTimes(2);
  });

  it('translates to the correct x, y position', () => {
    drawTankSprite(
      mockCtx as unknown as CanvasRenderingContext2D,
      150, 250, 20, 15, 0, 0, VGA_PALETTE.GREEN
    );

    // First translate should be the main position
    expect(mockCtx.translate).toHaveBeenNthCalledWith(1, 150, 250);
  });

  it('rotates the hull and turret by the correct radians', () => {
    const hullAngle = 90;
    const turretAngle = 180;
    const hullRad = (hullAngle * Math.PI) / 180;
    const turretRad = (turretAngle * Math.PI) / 180;

    drawTankSprite(
      mockCtx as unknown as CanvasRenderingContext2D,
      0, 0, 20, 15, hullAngle, turretAngle, VGA_PALETTE.RED
    );

    // First rotate is the hull
    expect(mockCtx.rotate).toHaveBeenNthCalledWith(1, hullRad);
    // Second rotate is the turret (relative to hull)
    expect(mockCtx.rotate).toHaveBeenNthCalledWith(2, turretRad - hullRad);
  });

  it('applies the primary color to the hull, turret, and barrel', () => {
    drawTankSprite(
      mockCtx as unknown as CanvasRenderingContext2D,
      0, 0, 20, 15, 0, 0, VGA_PALETTE.RED
    );

    // Check that primary color was applied to fillStyle (hull, turret)
    expect(fillStyleAssignments).toContain(VGA_PALETTE.RED);
    // Check that primary color was applied to strokeStyle (barrel)
    expect(strokeStyleAssignments).toContain(VGA_PALETTE.RED);
  });

  it('draws the track tread texture properly', () => {
    drawTankSprite(
      mockCtx as unknown as CanvasRenderingContext2D,
      0, 0, 20, 15, 0, 0, VGA_PALETTE.BLUE
    );

    // Verify fillRect is called multiple times for tracks and other parts
    // We don't need to check every single call, but verify that it iterates and draws
    expect((mockCtx.fillRect as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBeGreaterThan(3);

    // Ensure VGA_PALETTE.BLACK is used for tread texture
    expect(fillStyleAssignments).toContain(VGA_PALETTE.BLACK);
  });

  it('draws the muzzle flash/tip', () => {
    drawTankSprite(
      mockCtx as unknown as CanvasRenderingContext2D,
      0, 0, 20, 15, 0, 0, VGA_PALETTE.BLUE
    );

    // White color used for muzzle flash
    expect(fillStyleAssignments).toContain(VGA_PALETTE.WHITE);
  });

  it('executes canvas path functions for geometry', () => {
    drawTankSprite(
      mockCtx as unknown as CanvasRenderingContext2D,
      0, 0, 20, 15, 0, 0, VGA_PALETTE.BLUE
    );

    expect(mockCtx.beginPath).toHaveBeenCalled();
    expect(mockCtx.moveTo).toHaveBeenCalled();
    expect(mockCtx.lineTo).toHaveBeenCalled();
    expect(mockCtx.closePath).toHaveBeenCalled();
    expect(mockCtx.fill).toHaveBeenCalled();
    expect(mockCtx.stroke).toHaveBeenCalled();
    expect(mockCtx.arc).toHaveBeenCalled();
  });
});

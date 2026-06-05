/**
 * TankWars - Procedural tank sprite renderer (src/game/rendering/tankSprite.ts)
 *
 * Pure Canvas 2D drawing routine for the tank visual redesign (Step 1).
 *
 * - Uses ONLY CanvasRenderingContext2D API (no SVG, no external assets, no DOM).
 * - Geometric, clean, retro TankWars spirit (Scorched Earth / Worms style) but more detailed.
 * - Designed to be called from the 120 Hz engine render path (decoupled from React).
 * - Body/hull rotates with `angle`; turret + cannon rotate independently with `turretAngle`.
 * - `primaryColor` must be a value from VGA_PALETTE (new neon colors supported).
 *
 * This module is intentionally side-effect free except for the drawing commands on the provided ctx.
 * It is exported for the next integration step; it is NOT wired into GameEngine or TankManager yet.
 */

import { VGA_PALETTE } from "../../types/game";

/**
 * Draws a detailed procedural tank sprite.
 *
 * @param ctx - The canvas 2D context (must be valid, non-null).
 * @param x - World x position of the tank pivot (center of chassis).
 * @param y - World y position of the tank pivot (center of chassis).
 * @param width - Overall reference width of the tank (chassis + tracks span).
 * @param height - Overall reference height of the tank (chassis + tracks).
 * @param angle - Hull/body orientation in degrees (0 = flat, positive CCW). Used for sloped terrain support.
 * @param turretAngle - Independent turret/cannon orientation in degrees (world space).
 * @param primaryColor - Fill color for chassis, turret, and cannon (from VGA_PALETTE, including neon extensions).
 */
export function drawTankSprite(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  angle: number,
  turretAngle: number,
  primaryColor: string,
): void {
  const hullRad = (angle * Math.PI) / 180;
  const turretRad = (turretAngle * Math.PI) / 180;

  // Reference sizing (proportions tuned for small retro tanks ~14-18px wide)
  const hw = width * 0.5;
  const chassisHeight = height * 0.58;
  const trackHeight = Math.max(2.8, height * 0.34);
  const chassisTop = -chassisHeight * 0.5; // 0,0 is chassis vertical center; tracks hang below

  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(hullRad);

  // ============================================
  // CHENILLES (TRACKS) - lower sides, textured
  // ============================================
  const trackWidth = width * 0.96;
  const trackY = chassisTop + chassisHeight - 1.0; // overlaps chassis bottom slightly for solid contact look

  // Main track body (dark base)
  ctx.fillStyle = VGA_PALETTE.DARK_GRAY;
  ctx.fillRect(-trackWidth / 2, trackY, trackWidth, trackHeight);

  // Tread texture: blocky vertical grousers (dotted/segmented pattern)
  ctx.fillStyle = VGA_PALETTE.BLACK;
  const treadSpacing = width * 0.18;
  const treadWidth = width * 0.07;
  const treadInset = width * 0.09;
  const grouserYOffset = height * 0.06;
  const grouserHeightReduction = height * 0.12;

  for (
    let tx = -trackWidth / 2 + treadInset;
    tx < trackWidth / 2 - treadInset - 0.5;
    tx += treadSpacing
  ) {
    ctx.fillRect(
      tx,
      trackY + grouserYOffset,
      treadWidth,
      trackHeight - grouserHeightReduction,
    );
  }

  // Subtle top ridge on track for definition
  ctx.strokeStyle = VGA_PALETTE.GRAY;
  ctx.lineWidth = Math.max(0.5, width * 0.03);
  ctx.strokeRect(-trackWidth / 2, trackY, trackWidth, trackHeight);

  // ============================================
  // CHÂSSIS (BASE) - beveled polygon, primaryColor armor
  // ============================================
  const bevel = width * 0.11;
  const topInset = width * 0.09;
  const chBottom = chassisTop + chassisHeight;
  const hullOutlineOffset = width * 0.045;

  ctx.fillStyle = primaryColor;
  ctx.strokeStyle = VGA_PALETTE.DARK_GRAY;
  ctx.lineWidth = Math.max(0.7, width * 0.04);
  ctx.beginPath();
  // Beveled tank body (trapezoidal with chamfers for "blindage" retro look)
  ctx.moveTo(-hw + hullOutlineOffset, chBottom);
  ctx.lineTo(+hw - hullOutlineOffset, chBottom);
  ctx.lineTo(+hw - bevel, chBottom - bevel * 0.9);
  ctx.lineTo(+hw - bevel, chassisTop + bevel);
  ctx.lineTo(+hw - bevel - topInset, chassisTop);
  ctx.lineTo(-hw + bevel + topInset, chassisTop);
  ctx.lineTo(-hw + bevel, chassisTop + bevel);
  ctx.lineTo(-hw + bevel, chBottom - bevel * 0.9);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();

  // Panel line / armor seam (extra detail, keeps retro geometric)
  ctx.strokeStyle = VGA_PALETTE.DARK_GRAY;
  ctx.lineWidth = Math.max(0.5, width * 0.025);
  ctx.beginPath();
  const panelLineInset = width * 0.11;
  ctx.moveTo(-hw + panelLineInset, chassisTop + chassisHeight * 0.42);
  ctx.lineTo(+hw - panelLineInset, chassisTop + chassisHeight * 0.42);
  ctx.stroke();

  // ============================================
  // TOURELLE (DÔME) - arc-based dome reacting to player color
  // ============================================
  const turretMountY = chassisTop - height * 0.08; // sits proud on top of chassis
  const turretRadius = width * 0.25;

  ctx.save();
  ctx.translate(0, turretMountY);
  ctx.rotate(turretRad - hullRad); // Net rotation = world turret angle (independent of hull tilt)

  // Turret base band (small platform under dome)
  ctx.fillStyle = primaryColor;
  ctx.fillRect(
    -turretRadius * 0.72,
    -turretRadius * 0.18,
    turretRadius * 1.44,
    turretRadius * 0.42,
  );

  // Main dome (arc/circle) - classic rounded turret silhouette
  ctx.beginPath();
  ctx.arc(0, -turretRadius * 0.28, turretRadius * 0.92, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = VGA_PALETTE.DARK_GRAY;
  ctx.lineWidth = Math.max(0.7, width * 0.04);
  ctx.stroke();

  // Inner darker detail (hatch / ring) for depth without extra colors
  ctx.fillStyle = VGA_PALETTE.DARK_GRAY;
  ctx.beginPath();
  ctx.arc(0, -turretRadius * 0.22, turretRadius * 0.42, 0, Math.PI * 2);
  ctx.fill();

  // ============================================
  // CANON - thick line + muzzle, oriented by turretAngle
  // ============================================
  const barrelLength = width * 0.83;
  const barrelThickness = width * 0.12;
  const shadowThickness = barrelThickness + width * 0.08;

  // Shadow/outline pass (slightly behind for retro volume)
  ctx.strokeStyle = VGA_PALETTE.DARK_GRAY;
  ctx.lineWidth = shadowThickness;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(barrelLength * 0.97, 0);
  ctx.stroke();

  // Primary barrel (player color)
  ctx.strokeStyle = primaryColor;
  ctx.lineWidth = barrelThickness;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(barrelLength, 0);
  ctx.stroke();

  // Muzzle tip (bright accent - retro "flash" detail)
  ctx.fillStyle = VGA_PALETTE.WHITE;
  const muzzleX = barrelLength + width * 0.04;
  const muzzleHalf = width * 0.06;
  const muzzleThickness = width * 0.12;
  ctx.fillRect(
    muzzleX - muzzleThickness * 0.45,
    -muzzleHalf,
    muzzleThickness,
    muzzleHalf * 2,
  );

  ctx.restore(); // turret local transform
  ctx.restore(); // hull world transform
}

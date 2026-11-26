import { describe, it, expect } from "vitest";
import { getAccessibleTankTextColor, TANK_COLOR_POOL } from "../accessibleColor";
import { VGA_PALETTE } from "../../types/game";

function relativeLuminance(hex: string): number {
  const clean = hex.replace(/^#/, "");
  const r = parseInt(clean.slice(0, 2), 16) / 255;
  const g = parseInt(clean.slice(2, 4), 16) / 255;
  const b = parseInt(clean.slice(4, 6), 16) / 255;
  const toLinear = (c: number) =>
    c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}

function contrastRatio(foregroundHex: string, backgroundHex: string): number {
  const l1 = relativeLuminance(foregroundHex);
  const l2 = relativeLuminance(backgroundHex);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

describe("getAccessibleTankTextColor", () => {
  it.each(TANK_COLOR_POOL)(
    "ensures WCAG AA >= 4.5:1 text contrast on #000000 and #111111 for %s",
    (color) => {
      const textColor = getAccessibleTankTextColor(color);
      expect(textColor).toMatch(/^#[0-9a-f]{6}$/i);
      expect(contrastRatio(textColor, "#000000")).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(textColor, "#111111")).toBeGreaterThanOrEqual(4.5);
    },
  );

  it("remaps low-contrast BLUE and VOLT_PURPLE case-insensitively without altering VGA_PALETTE", () => {
    expect(VGA_PALETTE.BLUE).toBe("#5555FF");
    expect(VGA_PALETTE.VOLT_PURPLE).toBe("#B300FF");

    const lightBlue = getAccessibleTankTextColor("#5555ff");
    expect(lightBlue).toBe(getAccessibleTankTextColor(VGA_PALETTE.BLUE));
    expect(lightBlue.toLowerCase()).not.toBe("#5555ff");
    expect(getAccessibleTankTextColor("  #5555fF\t")).toBe(lightBlue);

    const lightPurple = getAccessibleTankTextColor("#b300ff");
    expect(lightPurple).toBe(getAccessibleTankTextColor(VGA_PALETTE.VOLT_PURPLE));
    expect(lightPurple.toLowerCase()).not.toBe("#b300ff");

    expect(getAccessibleTankTextColor("#ff0000")).toBe("#ff0000");
    expect(getAccessibleTankTextColor("constructor")).toBe("constructor");
  });
});

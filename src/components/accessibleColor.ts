import { VGA_PALETTE, type Color } from "../types/game";

/** Couleurs tanks jouables (palette VGA rétro classique + extensions néon haute visibilité)
 *  Chaque couleur est distincte et offre un excellent contraste sur fond sombre.
 */
export const TANK_COLOR_POOL: readonly Color[] = [
  VGA_PALETTE.BLUE, // #5555FF - Joueur 1 (Bleu par défaut)
  VGA_PALETTE.RED, // #FF5555 - Joueur 2 (Rouge par défaut)
  VGA_PALETTE.ELECTRIC_CYAN, // #00F7FF
  VGA_PALETTE.FLASH_GREEN, // #00FF7F
  VGA_PALETTE.NEON_PINK, // #FF1A8C
  VGA_PALETTE.CYBER_YELLOW, // #D7FF00
  VGA_PALETTE.FLUO_ORANGE, // #FF8C00
  VGA_PALETTE.VOLT_PURPLE, // #B300FF
] as const;

export const TANK_TEXT_COLOR_OVERRIDES: Readonly<Record<string, string>> = {
  [VGA_PALETTE.BLUE.toLowerCase()]: "#7F7FFF",
  [VGA_PALETTE.VOLT_PURPLE.toLowerCase()]: "#CC66FF",
};

/**
 * Returns a text-safe hex color with WCAG AA >= 4.5:1 contrast on dark (#000000 / #111111)
 * backgrounds while keeping VGA_PALETTE canvas and swatch colors untouched.
 */
export function getAccessibleTankTextColor(color: string): string {
  const key = color.trim().toLowerCase();
  return Object.hasOwn(TANK_TEXT_COLOR_OVERRIDES, key)
    ? TANK_TEXT_COLOR_OVERRIDES[key]
    : color;
}

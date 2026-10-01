/**
 * Marque du menu : logo 3 (tank canon levé, mot-image empilé)
 * et favicon C, grille 16×16. Couleurs VGA seulement.
 */

const TANK_COLOR = {
  Y: "#FFFF55",
  C: "#55FFFF",
  M: "#FF55FF",
  W: "#FFFFFF",
} as const;

const SHADOW = "#0000AA";
const OUTLINE = "#000000";

const LINE_TOP: readonly (readonly [string, string])[] = [
  ["B", "#5555FF"],
  ["E", "#55FFFF"],
  ["S", "#55FF55"],
  ["T", "#FFFF55"],
  ["T", "#FF5555"],
  ["E", "#FF55FF"],
  ["R", "#FFFFFF"],
  ["'", "#FFFF55"],
  ["S", "#55FFFF"],
];

const LINE_BOTTOM: readonly (readonly [string, string])[] = [
  ["T", "#FFFF55"],
  ["A", "#FF5555"],
  ["N", "#55FF55"],
  ["K", "#55FFFF"],
  ["W", "#FF55FF"],
  ["A", "#5555FF"],
  ["R", "#FFFF55"],
  ["S", "#FFFFFF"],
];

const FONT: Record<string, readonly string[]> = {
  A: [".###.", "#...#", "#...#", "#####", "#...#", "#...#", "#...#"],
  B: ["####.", "#...#", "#...#", "####.", "#...#", "#...#", "####."],
  E: ["#####", "#....", "#....", "####.", "#....", "#....", "#####"],
  K: ["#...#", "#..#.", "#.#..", "##...", "#.#..", "#..#.", "#...#"],
  N: ["#...#", "##..#", "#.#.#", "#..##", "#...#", "#...#", "#...#"],
  R: ["####.", "#...#", "#...#", "####.", "#.#..", "#..#.", "#...#"],
  S: [".####", "#....", "#....", ".###.", "....#", "....#", "####."],
  T: ["#####", "..#..", "..#..", "..#..", "..#..", "..#..", "..#.."],
  W: ["#...#", "#...#", "#...#", "#.#.#", "#.#.#", "##.##", "#...#"],
  "'": ["#", "#", ".", ".", ".", ".", "."],
};

/** Favicon C : canon levé. Le point est le fond noir. */
export const FAVICON_ROWS: readonly string[] = [
  "................",
  "................",
  ".........WW.....",
  "........WWC.....",
  "......CCCCCC....",
  ".....CCCCCCCC...",
  "....YYYYYYYYYY..",
  "..YYYYYYYYYYYY..",
  "..YYYYYYYYYYYY..",
  "..MMMMMMMMMMMM..",
  "..M.M.M.M.M.M...",
  "..MMMMMMMMMMMM..",
  "................",
  "................",
  "................",
  "................",
];

interface Pixel {
  x: number;
  y: number;
  color: string;
}

export interface LogoPath {
  color: string;
  d: string;
}

export interface GameLogoArt {
  width: number;
  height: number;
  paths: readonly LogoPath[];
}

function tankColor(ch: string): string {
  if (ch === "Y" || ch === "C" || ch === "M" || ch === "W") return TANK_COLOR[ch];
  throw new Error(`Pixel de tank inconnu: ${ch}`);
}

function glyph(ch: string): readonly string[] {
  const rows = FONT[ch];
  if (!rows) throw new Error(`Glyphe manquant: ${ch}`);
  return rows;
}

function tankPixels(rows: readonly string[], scale: number): Pixel[] {
  const pixels: Pixel[] = [];
  rows.forEach((row, y) => {
    [...row].forEach((ch, x) => {
      if (ch === ".") return;
      const color = tankColor(ch);
      for (let py = 0; py < scale; py += 1) {
        for (let px = 0; px < scale; px += 1) {
          pixels.push({ x: x * scale + px, y: y * scale + py, color });
        }
      }
    });
  });
  return pixels;
}

function lineWidth(line: readonly (readonly [string, string])[], block: number): number {
  let width = 0;
  for (const [ch] of line) width += glyph(ch)[0]!.length * block + block;
  return width - block;
}

function textPixels(
  line: readonly (readonly [string, string])[],
  block: number,
  originX: number,
  originY: number,
): Pixel[] {
  const pixels: Pixel[] = [];
  let cursor = originX;
  for (const [ch, color] of line) {
    const rows = glyph(ch);
    rows.forEach((row, gy) => {
      [...row].forEach((cell, gx) => {
        if (cell !== "#") return;
        for (let py = 0; py < block; py += 1) {
          for (let px = 0; px < block; px += 1) {
            pixels.push({
              x: cursor + gx * block + px,
              y: originY + gy * block + py,
              color,
            });
          }
        }
      });
    });
    cursor += rows[0]!.length * block + block;
  }
  return pixels;
}

function stackedLogoPixels(): Pixel[] {
  const tankScale = 3;
  const topBlock = 2;
  const botBlock = 4;
  const lineGap = 5;
  const gap = 8;
  const topW = lineWidth(LINE_TOP, topBlock);
  const botW = lineWidth(LINE_BOTTOM, botBlock);
  const textW = Math.max(topW, botW);
  const topH = 7 * topBlock;
  const tankW = 16 * tankScale;
  const tankH = 16 * tankScale;
  const tankOriginX = 2 + Math.floor((Math.max(tankW, textW) - tankW) / 2);
  const textOriginY = 2 + tankH + gap;
  return [
    ...tankPixels(FAVICON_ROWS, tankScale).map((pixel) => ({
      x: pixel.x + tankOriginX,
      y: pixel.y + 2,
      color: pixel.color,
    })),
    ...textPixels(LINE_TOP, topBlock, 2 + Math.floor((textW - topW) / 2), textOriginY),
    ...textPixels(
      LINE_BOTTOM,
      botBlock,
      2 + Math.floor((textW - botW) / 2),
      textOriginY + topH + lineGap,
    ),
  ];
}

function rasterToPaths(pixels: readonly Pixel[]): GameLogoArt {
  const shadow = 2;
  const pad = 3;
  let maxX = 0;
  let maxY = 0;
  for (const pixel of pixels) {
    if (pixel.x > maxX) maxX = pixel.x;
    if (pixel.y > maxY) maxY = pixel.y;
  }
  const width = maxX + 1 + pad + shadow;
  const height = maxY + 1 + pad + shadow;
  const grid: Array<string | undefined> = new Array(width * height);
  const paint = (x: number, y: number, color: string): void => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    grid[y * width + x] = color;
  };
  for (const pixel of pixels) paint(pixel.x + shadow, pixel.y + shadow, SHADOW);
  for (const pixel of pixels) {
    paint(pixel.x - 1, pixel.y, OUTLINE);
    paint(pixel.x + 1, pixel.y, OUTLINE);
    paint(pixel.x, pixel.y - 1, OUTLINE);
    paint(pixel.x, pixel.y + 1, OUTLINE);
  }
  for (const pixel of pixels) paint(pixel.x, pixel.y, pixel.color);

  const byColor = new Map<string, string[]>();
  for (let y = 0; y < height; y += 1) {
    let x = 0;
    while (x < width) {
      const color = grid[y * width + x];
      if (!color) {
        x += 1;
        continue;
      }
      let run = 1;
      while (x + run < width && grid[y * width + x + run] === color) run += 1;
      const commands = byColor.get(color);
      const command = `M${x} ${y}h${run}v1h${-run}z`;
      if (commands) commands.push(command);
      else byColor.set(color, [command]);
      x += run;
    }
  }

  const order = [
    SHADOW,
    OUTLINE,
    ...[...byColor.keys()].filter((color) => color !== SHADOW && color !== OUTLINE).sort(),
  ];
  const paths = order
    .filter((color) => byColor.has(color))
    .map((color) => ({ color, d: (byColor.get(color) ?? []).join("") }));
  return { width, height, paths };
}

export const GAME_LOGO: GameLogoArt = rasterToPaths(stackedLogoPixels());

export const GAME_LOGO_COMPACT = {
  width: Math.round(GAME_LOGO.width * 0.8),
  height: Math.round(GAME_LOGO.height * 0.8),
} as const;

export function faviconSvgMarkup(): string {
  const rects = ['<rect width="16" height="16" fill="#000000"/>'];
  FAVICON_ROWS.forEach((row, y) => {
    let x = 0;
    while (x < row.length) {
      const ch = row[x];
      if (!ch || ch === ".") {
        x += 1;
        continue;
      }
      let run = 1;
      while (row[x + run] === ch) run += 1;
      rects.push(
        `<rect x="${x}" y="${y}" width="${run}" height="1" fill="${tankColor(ch)}"/>`,
      );
      x += run;
    }
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" shape-rendering="crispEdges">${rects.join("")}</svg>\n`;
}

/** Image carrée du favicon. Les pixels vides restent noirs et opaques. */
export function faviconRgba(size: number): Uint8Array {
  if (!Number.isInteger(size) || size < 16) {
    throw new Error(`Taille de favicon invalide: ${size}`);
  }
  const rgba = new Uint8Array(size * size * 4);
  for (let i = 3; i < rgba.length; i += 4) rgba[i] = 255;
  for (let y = 0; y < size; y += 1) {
    const row = FAVICON_ROWS[Math.floor((y * 16) / size)];
    if (!row) continue;
    for (let x = 0; x < size; x += 1) {
      const ch = row[Math.floor((x * 16) / size)];
      if (!ch || ch === ".") continue;
      const color = tankColor(ch);
      const offset = (y * size + x) * 4;
      rgba[offset] = Number.parseInt(color.slice(1, 3), 16);
      rgba[offset + 1] = Number.parseInt(color.slice(3, 5), 16);
      rgba[offset + 2] = Number.parseInt(color.slice(5, 7), 16);
    }
  }
  return rgba;
}

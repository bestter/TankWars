/// <reference types="node" />
import { inflateSync } from "node:zlib";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { FAVICON_ROWS, faviconRgba, faviconSvgMarkup, GAME_LOGO } from "../gameLogoArt";

function readPng(fileName: string): { width: number; height: number; rgba: Buffer } {
  const buf = fs.readFileSync(path.resolve(process.cwd(), "public", fileName));
  expect([...buf.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  const idat: Buffer[] = [];
  let offset = 8;
  while (offset + 8 <= buf.length) {
    const length = buf.readUInt32BE(offset);
    const type = buf.subarray(offset + 4, offset + 8).toString("ascii");
    const data = buf.subarray(offset + 8, offset + 8 + length);
    if (type === "IDAT") idat.push(data);
    offset += 12 + length;
    if (type === "IEND") break;
  }
  const inflated = inflateSync(Buffer.concat(idat));
  const rgba = Buffer.alloc(width * height * 4);
  const stride = width * 4 + 1;
  for (let y = 0; y < height; y += 1) {
    expect(inflated[y * stride]).toBe(0);
    inflated.copy(rgba, y * width * 4, y * stride + 1, y * stride + 1 + width * 4);
  }
  return { width, height, rgba };
}

describe("fichiers de marque", () => {
  it("dessine le logo 3 à la taille retenue", () => {
    expect(GAME_LOGO.width).toBe(195);
    expect(GAME_LOGO.height).toBe(110);
    expect(FAVICON_ROWS).toHaveLength(16);
    for (const row of FAVICON_ROWS) expect(row).toHaveLength(16);
  });

  it("aligne le favicon svg sur la grille du canon levé", () => {
    const markup = faviconSvgMarkup();
    const disk = fs.readFileSync(path.resolve(process.cwd(), "public/favicon.svg"), "utf8");
    expect(disk).toBe(markup);
    expect(disk).not.toContain("filter");
    expect(disk).not.toContain("<text");
    expect(disk).toContain('viewBox="0 0 16 16"');
  });

  it("publie les png 32, 180 et 512 depuis la même grille", () => {
    for (const [fileName, size] of [
      ["favicon-32.png", 32],
      ["apple-touch-icon.png", 180],
      ["icon-512.png", 512],
    ] as const) {
      const png = readPng(fileName);
      expect(png.width).toBe(size);
      expect(png.height).toBe(size);
      expect(Buffer.from(png.rgba)).toEqual(Buffer.from(faviconRgba(size)));
    }
  });

  it("branche les icônes et le theme_color VGA", () => {
    const index = fs.readFileSync(path.resolve(process.cwd(), "index.html"), "utf8");
    expect(index).toContain('href="/favicon.svg"');
    expect(index).toContain('href="/favicon-32.png"');
    expect(index).toContain('href="/apple-touch-icon.png"');

    const manifest = fs.readFileSync(path.resolve(process.cwd(), "public/manifest.json"), "utf8");
    expect(manifest).toContain('"theme_color": "#55FFFF"');
    expect(manifest).toContain('"/icon-512.png"');
    expect(manifest).toContain('"purpose": "maskable"');
  });
});

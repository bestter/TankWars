import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

describe('HTML head theme and color-scheme metadata (#406)', () => {
  const indexHtmlPath = path.resolve(__dirname, '../../index.html');
  const indexCssPath = path.resolve(__dirname, '../index.css');
  const manifestPath = path.resolve(__dirname, '../../public/manifest.json');
  const distHtmlPath = path.resolve(__dirname, '../../dist/index.html');

  const indexHtml = fs.readFileSync(indexHtmlPath, 'utf-8');
  const indexCss = fs.readFileSync(indexCssPath, 'utf-8');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));

  it('contains exactly one theme-color meta tag set to #000000 without media attribute', () => {
    const themeColorMatches = indexHtml.match(/<meta\s+[^>]*name=["']theme-color["'][^>]*>/gi) || [];
    expect(themeColorMatches).toHaveLength(1);

    const themeColorTag = themeColorMatches[0];
    expect(themeColorTag).toMatch(/content=["']#000000["']/i);
    expect(themeColorTag).not.toMatch(/\smedia=/i);
  });

  it('contains exactly one color-scheme meta tag set to "dark light"', () => {
    const colorSchemeMatches = indexHtml.match(/<meta\s+[^>]*name=["']color-scheme["'][^>]*>/gi) || [];
    expect(colorSchemeMatches).toHaveLength(1);

    const colorSchemeTag = colorSchemeMatches[0];
    expect(colorSchemeTag).toMatch(/content=["']dark light["']/i);
  });

  it('places color-scheme early in <head>, before styles and scripts', () => {
    const headMatch = indexHtml.match(/<head>([\s\S]*?)<\/head>/i);
    expect(headMatch).not.toBeNull();
    const headContent = headMatch![1];

    const charsetIndex = headContent.search(/<meta\s+charset=/i);
    const colorSchemeIndex = headContent.search(/<meta\s+[^>]*name=["']color-scheme["']/i);
    const themeColorIndex = headContent.search(/<meta\s+[^>]*name=["']theme-color["']/i);
    const scriptIndex = headContent.search(/<script/i);
    const styleIndex = headContent.search(/<style|<link\s+[^>]*rel=["']stylesheet["']/i);

    expect(charsetIndex).toBeGreaterThanOrEqual(0);
    expect(colorSchemeIndex).toBeGreaterThanOrEqual(0);
    expect(themeColorIndex).toBeGreaterThanOrEqual(0);

    // Annoncé tôt : après le charset
    expect(colorSchemeIndex).toBeGreaterThan(charsetIndex);

    // Annoncé avant toute feuille de style ou script si présent dans le head
    if (scriptIndex >= 0) {
      expect(colorSchemeIndex).toBeLessThan(scriptIndex);
    }
    if (styleIndex >= 0) {
      expect(colorSchemeIndex).toBeLessThan(styleIndex);
    }
  });

  it('harmonizes CSS :root color-scheme with the HTML declaration (dark light)', () => {
    expect(indexCss).toMatch(/:root\s*\{[\s\S]*?color-scheme:\s*dark light;/);
    // Les fonds existants et la requête media restent préservés
    expect(indexCss).toContain('--bg: #fff;');
    expect(indexCss).toContain('--bg: #16171d;');
    expect(indexCss).toContain('@media (prefers-color-scheme: dark)');
  });

  it('preserves PWA manifest colors unchanged', () => {
    expect(manifest.background_color).toBe('#000000');
    expect(manifest.theme_color).toBe('#55FFFF');
  });

  it('persists metadata in production build dist/index.html when present', () => {
    if (fs.existsSync(distHtmlPath)) {
      const distHtml = fs.readFileSync(distHtmlPath, 'utf-8');
      expect(distHtml).toMatch(/<meta\s+[^>]*name=["']color-scheme["'][^>]*content=["']dark light["']/i);
      expect(distHtml).toMatch(/<meta\s+[^>]*name=["']theme-color["'][^>]*content=["']#000000["']/i);
    }
  });
});

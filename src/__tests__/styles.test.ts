import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

describe('styles CSS cleanup (#405)', () => {
  const appCssPath = path.resolve(__dirname, '../App.css');
  const indexCssPath = path.resolve(__dirname, '../index.css');

  const appCss = fs.readFileSync(appCssPath, 'utf-8');
  const indexCss = fs.readFileSync(indexCssPath, 'utf-8');

  it('removes unused Vite starter template selectors from App.css', () => {
    const deadSelectors = [
      '.counter',
      '.hero',
      '#center',
      '#next-steps',
      '#docs',
      '#spacer',
      '.ticks',
    ];

    for (const selector of deadSelectors) {
      expect(appCss).not.toContain(selector);
    }
  });

  it('preserves retro VGA UI primitives and game styles in App.css', () => {
    expect(appCss).toContain('Retro VGA UI primitives for game overlays/HUD/buttons.');
    expect(appCss).toContain('.retro-modal');
    expect(appCss).toContain('.retro-hud');
    expect(appCss).toContain('.retro-btn');
  });

  it('centers native <dialog> modals in the top layer and contains overscroll (#410)', () => {
    expect(appCss).toContain('inset: 0;');
    expect(appCss).toContain('margin: auto;');
    expect(appCss).toContain('.retro-modal-shop[open]');
    expect(appCss).toContain('dialog.retro-modal:modal');
    expect(appCss).toContain('dialog.retro-modal::backdrop');
    expect(appCss).toContain('overscroll-behavior: contain;');
  });

  it('defers offscreen rendering for .game-canvas without affecting other canvases (#411)', () => {
    expect(appCss).toMatch(
      /\.game-canvas\s*\{[^}]*content-visibility:\s*auto;[^}]*contain-intrinsic-size:\s*auto 800px auto 480px;[^}]*\}/,
    );
  });

  it('hides native <progress> parts on .retro-spinner without unrecognized ::slider-fill', () => {
    expect(appCss).toContain('progress.retro-spinner:indeterminate');
    expect(appCss).toContain('appearance: none;');
    expect(appCss).toContain('progress.retro-spinner:indeterminate::-webkit-progress-bar');
    expect(appCss).toContain('progress.retro-spinner:indeterminate::-webkit-progress-value');
    expect(appCss).toContain('progress.retro-spinner:indeterminate::-moz-progress-bar');
    expect(appCss).not.toContain('::slider-fill');
  });

  it('captures pointer events on .retro-hud-weapons while letting clicks pass through .retro-hud, .retro-wait-status, and .retro-spinner', () => {
    expect(appCss).toMatch(/\.retro-hud\s*\{[^}]*pointer-events:\s*none;/);
    expect(appCss).toMatch(/\.retro-hud-weapons\s*\{[^}]*pointer-events:\s*auto;/);
    expect(appCss).not.toMatch(/\.retro-hud-weapons\s*\{[^}]*pointer-events:\s*none;/);
    expect(appCss).toMatch(/\.retro-wait-status\s*\{[^}]*pointer-events:\s*none;/);
    expect(appCss).toMatch(/progress\.retro-spinner:indeterminate\s*\{[^}]*pointer-events:\s*none;/);
  });

  it('removes orphaned CSS variables and demo selectors from index.css', () => {
    const orphanedVariables = [
      '--accent:',
      '--accent-bg:',
      '--accent-border:',
      '--social-bg:',
      '--shadow:',
    ];

    for (const variable of orphanedVariables) {
      expect(indexCss).not.toContain(variable);
    }

    expect(indexCss).not.toContain('.counter');
    expect(indexCss).not.toContain('#social');
  });

  it('preserves #root geometry and active base styles in index.css', () => {
    expect(indexCss).toContain('width: 1126px;');
    expect(indexCss).toContain('max-width: 100%;');
    expect(indexCss).toContain('code {');
    expect(indexCss).toContain('--code-bg');
    expect(indexCss).toContain('--text');
    expect(indexCss).toContain('--text-h');
    expect(indexCss).toContain('--border');
  });

  it('supports fluid mobile layout, safe-areas, adaptive container queries, and touch targets (#445)', () => {
    expect(indexCss).toContain('min-height: 100dvh;');
    expect(appCss).toContain('min-height: 100dvh;');
    expect(appCss).toContain('env(safe-area-inset-');
    expect(appCss).toContain('container: combat / inline-size;');
    expect(appCss).toContain('@container combat');
    expect(appCss).toMatch(/\.game-canvas\s*\{[^}]*display:\s*block;[^}]*aspect-ratio:\s*800\s*\/\s*480;/);
    expect(appCss).toMatch(/\.mobile-controls-panel\s*\{[^}]*flex-wrap:\s*wrap;/);
    expect(appCss).toMatch(/\.retro-player-row\s*\{[^}]*flex-wrap:\s*wrap;/);
    expect(appCss).toMatch(/\.retro-logo\s*\{[^}]*max-width:\s*100%;[^}]*height:\s*auto;/);
    expect(appCss).toMatch(/\.retro-inc-btn\s*\{[^}]*min-block-size:\s*24px;/);
    expect(appCss).toContain('@media (pointer: coarse)');
    expect(appCss).not.toMatch(/(?:html|body)\s*\{[^}]*overflow-x:\s*(?:hidden|clip)/);
    expect(indexCss).not.toMatch(/(?:html|body)\s*\{[^}]*overflow-x:\s*(?:hidden|clip)/);
  });

  it('sizes GameOverOverlay and clamps ShotEarningsOverlay against their own 2D stage containers (#446)', () => {
    expect(appCss).not.toMatch(/\.combat-canvas-stage\s*\{[^}]*container(?:-type)?\s*:/);
    expect(appCss).toMatch(
      /\.game-over-overlay\s*\{[^}]*inset:\s*0;[^}]*justify-content:\s*safe center;[^}]*container:\s*game-over \/ size;/,
    );
    expect(appCss).toMatch(
      /\.game-over-winner\s*\{[^}]*font-size:\s*clamp\(1\.25rem,\s*0\.25rem \+ min\(6\.5cqi,\s*10\.5cqb\),\s*3\.125rem\);/,
    );
    expect(appCss).toMatch(
      /\.game-over-subtitle\s*\{[^}]*font-size:\s*clamp\(0\.75rem,\s*0\.35rem \+ min\(2cqi,\s*3\.4cqb\),\s*1\.5rem\);/,
    );
    expect(appCss).toMatch(/\.shot-earnings-overlay\s*\{[^}]*overflow:\s*clip;[^}]*container:\s*shot-earnings \/ size;/);
    expect(appCss).toMatch(
      /@supports\s*\(translate:\s*1cqi 1cqb\)\s*and\s*\(font-size:\s*1cqi\)\s*\{\s*\.shot-earnings-line\s*\{[^}]*translate:[^}]*50%[^}]*100cqi - 100%/,
    );
    const keyframesBlock = appCss.match(/@keyframes shot-earnings-float\s*\{[\s\S]*?\n\}/)?.[0] ?? '';
    expect(keyframesBlock).toContain('translateY(-100%)');
    expect(keyframesBlock).not.toContain('translate(-50%');
  });

  it('preserves desktop 800x480 stage, overlaid HUD, and top-right header on short desktop viewports >= 1025px (#446)', () => {
    expect(appCss).toContain('@media (max-width: 1024px) and (max-height: 540px)');
    expect(appCss).not.toMatch(/@media\s*\(\s*max-height:\s*540px\s*\)/);
    expect(appCss).not.toMatch(/@media\s*\(\s*min-width:\s*1025px\s*\)\s*and\s*\(\s*min-height:\s*520px\s*\)/);
    expect(appCss).toMatch(/\.app-shell\s*\{[^}]*container:\s*app-shell\s*\/\s*inline-size;/);
    const [beforeSupports, supportsBlock = ''] = appCss.split('@supports (container-type: inline-size)');
    expect(beforeSupports).toMatch(
      /@media\s*\(\s*min-width:\s*1025px\s*\)\s*and\s*\(\s*pointer:\s*fine\s*\)\s*\{[^}]*\.app-header[\s\S]*?\.app-header-lang\s*\{[^}]*position:\s*absolute;/,
    );
    expect(beforeSupports).not.toMatch(/@media[^{]*min-width:\s*1080px/);
    expect(supportsBlock).toMatch(
      /@media\s*\(\s*min-width:\s*1025px\s*\)\s*and\s*\(\s*pointer:\s*fine\s*\)\s*\{[\s\S]*?\.app-header-lang\s*\{[^}]*position:\s*static;/,
    );
    expect(supportsBlock).toMatch(
      /@media\s*\(\s*min-width:\s*1025px\s*\)\s*and\s*\(\s*pointer:\s*fine\s*\)\s*\{\s*@container app-shell \(inline-size >= 960px\)[\s\S]*?\.app-header-lang\s*\{[^}]*position:\s*absolute;/,
    );
    expect(supportsBlock).toMatch(
      /@media\s*\(\s*min-width:\s*1080px\s*\)\s*\{\s*@container app-shell \(inline-size >= 1024px\)[\s\S]*?\.app-header-lang\s*\{[^}]*position:\s*absolute;/,
    );
    const fallbackAndResetMatches = appCss.match(
      /@media\s*\(\s*min-width:\s*1025px\s*\)\s*,\s*\(\s*min-width:\s*760px\s*\)\s*and\s*\(\s*min-height:\s*541px\s*\)/g,
    );
    expect(fallbackAndResetMatches).toHaveLength(2);
    expect(appCss).toMatch(
      /@media\s*\(\s*min-width:\s*1025px\s*\)\s*,\s*\(\s*min-height:\s*541px\s*\)\s*\{\s*@container combat \(inline-size >= 720px\)/,
    );
  });

  it('constrains native <dialog> modals on every side using safe-area insets (#446)', () => {
    expect(appCss).toMatch(
      /\.retro-modal\s*\{[^}]*--modal-safe-top:\s*max\(10px,\s*env\(safe-area-inset-top,\s*0px\)\);[^}]*--modal-safe-right:\s*max\(8px,\s*env\(safe-area-inset-right,\s*0px\)\);[^}]*--modal-safe-bottom:\s*max\(10px,\s*env\(safe-area-inset-bottom,\s*0px\)\);[^}]*--modal-safe-left:\s*max\(8px,\s*env\(safe-area-inset-left,\s*0px\)\);[^}]*inset:\s*0;[^}]*inset:\s*var\(--modal-safe-top\)\s+var\(--modal-safe-right\)\s+var\(--modal-safe-bottom\)\s+var\(--modal-safe-left\);[^}]*max-width:\s*calc\(100%\s*-\s*var\(--modal-safe-left\)\s*-\s*var\(--modal-safe-right\)\);[^}]*max-height:\s*calc\(100dvh\s*-\s*var\(--modal-safe-top\)\s*-\s*var\(--modal-safe-bottom\)\);/s,
    );
    expect(appCss).toMatch(
      /\.retro-modal-shop\s*\{[^}]*max-height:\s*min\(540px,\s*calc\(100dvh\s*-\s*var\(--modal-safe-top\)\s*-\s*var\(--modal-safe-bottom\)\)\);[^}]*overflow-y:\s*auto;[^}]*overscroll-behavior:\s*contain;/s,
    );
  });

  it('stacks desktop HUD inside .combat-hud-stack without fixed top, isolates stage border, and keeps vmin fallback on .zeus-announcement (#446)', () => {
    expect(appCss).toMatch(
      /\.combat-canvas-stage\s*\{[^}]*border:\s*3px solid #aaaaaa;[^}]*box-sizing:\s*border-box;/,
    );
    expect(appCss).toMatch(/\.game-canvas\s*\{[^}]*border:\s*0;/);
    expect(appCss).toMatch(
      /\.zeus-announcement\s*\{[^}]*font-size:\s*clamp\(0\.75rem,\s*0\.65rem \+ 1\.2vmin,\s*1rem\);/,
    );
    expect(appCss).toMatch(
      /@supports\s*\(font-size:\s*1cqi\)\s*\{\s*\.zeus-announcement\s*\{[^}]*font-size:\s*clamp\(0\.75rem,\s*0\.65rem \+ 1\.2cqi,\s*1rem\);/,
    );
    expect(appCss).not.toMatch(/top:\s*34px;/);
  });
});

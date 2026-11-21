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
});

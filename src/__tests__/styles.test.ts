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

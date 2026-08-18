/// <reference types="node" />
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

describe('Content Security Policy (CSP) Safety Checks', () => {
  it('should require style-src to allow unsafe-inline in index.html to prevent Vite and React UI breakage', () => {
    const indexPath = path.resolve(process.cwd(), 'index.html');
    const content = fs.readFileSync(indexPath, 'utf-8');

    // Regardons si la balise meta de CSP est présente
    expect(content).toContain('http-equiv="Content-Security-Policy"');

    // Recherchons spécifiquement la ligne contenant Content-Security-Policy
    const lines = content.split('\n');
    const cspLine = lines.find((l: string) => l.includes('Content-Security-Policy'));
    expect(cspLine).toBeDefined();

    const cspMatch = cspLine!.match(/content="([^"]+)"/);
    expect(cspMatch).not.toBeNull();

    const cspContent = cspMatch![1];
    const directives = cspContent.split(';').map((d: string) => d.trim()).filter(Boolean);
    const styleSrcDirective = directives.find((d: string) => d.startsWith('style-src'));

    expect(styleSrcDirective).toBeDefined();
    expect(styleSrcDirective).toContain("'unsafe-inline'");
  });

  it('should require style-src to allow unsafe-inline in public/_headers to prevent production UI breakage', () => {
    const headersPath = path.resolve(process.cwd(), 'public/_headers');
    const content = fs.readFileSync(headersPath, 'utf-8');

    // Regardons si l'en-tête CSP est présent
    expect(content).toContain('Content-Security-Policy:');

    // Vérifions que style-src contient 'unsafe-inline'
    const lines = content.split('\n');
    const cspLine = lines.find((l: string) => l.includes('Content-Security-Policy:'));

    expect(cspLine).toBeDefined();
    expect(cspLine).toContain('style-src');
    expect(cspLine).toContain("'unsafe-inline'");
  });
});

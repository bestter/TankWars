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

    const scriptSrcDirective = directives.find((d: string) => d.startsWith('script-src'));
    expect(scriptSrcDirective).toContain('https://static.cloudflareinsights.com');
    expect(cspContent).toContain('https://cloudflareinsights.com');
    expect(cspContent).toContain('https://static.cloudflareinsights.com');
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
    expect(cspLine).toContain('https://static.cloudflareinsights.com');
    expect(cspLine).toContain('https://cloudflareinsights.com');
  });
});

describe('Service worker cache strategy', () => {
  it('uses network-first for navigations and ignores cross-origin fetches', () => {
    const swPath = path.resolve(process.cwd(), 'public/sw.js');
    const content = fs.readFileSync(swPath, 'utf-8');
    expect(content).toContain('e.request.mode === "navigate"');
    expect(content).toContain('self.location.origin');
    expect(content).toContain('throw err');
  });
});

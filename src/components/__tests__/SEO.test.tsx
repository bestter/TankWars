// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { HelmetProvider } from 'react-helmet-async';
import { SEO } from '../SEO';
import indexHtml from '../../../index.html?raw';
import robotsText from '../../../public/robots.txt?raw';
import sitemapXml from '../../../public/sitemap.xml?raw';

let currentLanguage: string | undefined = 'fr';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => `trans_${currentLanguage ?? 'en'}_${key}`,
    i18n: {
      language: currentLanguage,
    },
  }),
}));

describe('static SEO metadata', () => {
  it('publishes the description, canonical URL and share card in the initial HTML', () => {
    const canonical = 'https://tankwars-game.com/';
    const html = new DOMParser().parseFromString(indexHtml, 'text/html');
    const sitemap = new DOMParser().parseFromString(sitemapXml, 'application/xml');

    expect(sitemap.querySelector('parsererror')).toBeNull();
    const descriptions = html.head.querySelectorAll<HTMLMetaElement>('meta[name="description"]');
    expect(descriptions).toHaveLength(1);
    expect(descriptions[0]?.content).toBe('Play a retro tank artillery game in your browser with destructible terrain. Play against the AI or with friends.');
    expect(html.head.querySelector('link[rel="canonical"]')?.getAttribute('href')).toBe(canonical);
    expect(html.head.querySelector('meta[property="og:url"]')?.getAttribute('content')).toBe(canonical);
    expect(html.head.querySelector('meta[property="og:title"]')?.getAttribute('content')).toBe(html.title);
    expect(html.head.querySelector('meta[property="og:image"]')?.getAttribute('content')).toBe(`${canonical}icon-512.png`);
    expect(html.head.querySelector('meta[name="twitter:card"]')?.getAttribute('content')).toBe('summary');
    expect(html.head.querySelector('meta[name="twitter:image"]')?.getAttribute('content')).toBe(`${canonical}icon-512.png`);
    expect(robotsText).toContain(`Sitemap: ${canonical}sitemap.xml`);
    expect(sitemap.querySelector('loc')?.textContent).toBe(canonical);
  });

  it('serves a readable game overview and controls link before JavaScript runs', () => {
    const html = new DOMParser().parseFromString(indexHtml, 'text/html');
    const overview = html.querySelector('#root > main');

    expect(overview?.querySelector('h1')?.textContent).toBe(html.title);
    expect(overview?.textContent).toContain('destructible terrain');
    expect(overview?.textContent).toContain('two to four players');
    expect(overview?.querySelector('a[href]')?.getAttribute('href')).toBe('https://github.com/bestter/TankWars#controls');
  });
});

describe('SEO component', () => {
  beforeEach(() => {
    const html = new DOMParser().parseFromString(indexHtml, 'text/html');
    document.head.append(...html.head.querySelectorAll('meta[name="description"]'));
  });

  afterEach(() => {
    cleanup();
    document.title = '';
    document.documentElement.removeAttribute('lang');
    currentLanguage = 'fr';
    document.head.querySelectorAll('meta[name="description"]').forEach((tag) => tag.remove());
  });

  it('creates a localized description when the initial tag is missing', () => {
    document.head.querySelector('meta[name="description"]')?.remove();
    render(<HelmetProvider><SEO titleKey="seo_title" descriptionKey="seo_description" /></HelmetProvider>);
    const descriptions = document.head.querySelectorAll<HTMLMetaElement>('meta[name="description"]');
    expect(descriptions).toHaveLength(1);
    expect(descriptions[0]?.content).toBe('trans_fr_seo_description');
  });

  it.each([
    ['fr-CA', 'fr'],
    ['en', 'en'],
    [undefined, 'en'],
  ])('localizes page metadata for %s using the existing description tag', (language, expectedLang) => {
    currentLanguage = language;
    const description = document.head.querySelector('meta[name="description"]');

    const seo = (
      <HelmetProvider>
        <SEO titleKey="seo_title" descriptionKey="seo_description" />
      </HelmetProvider>
    );
    const { rerender } = render(seo);

    expect(document.title).toBe(`trans_${language ?? 'en'}_seo_title`);
    expect(description?.getAttribute('content')).toBe(`trans_${language ?? 'en'}_seo_description`);
    expect(document.documentElement.lang).toBe(expectedLang);
    expect(document.head.querySelectorAll('meta[name="description"]')).toHaveLength(1);
    expect(document.querySelector('link[rel="canonical"]')).toBeNull();
    expect(document.querySelector('meta[property^="og:"]')).toBeNull();
    expect(document.querySelector('meta[name^="twitter:"]')).toBeNull();

    currentLanguage = expectedLang === 'fr' ? 'en' : 'fr';
    rerender(
      <HelmetProvider>
        <SEO titleKey="seo_title" descriptionKey="seo_description" />
      </HelmetProvider>
    );

    expect(description?.getAttribute('content')).toBe(`trans_${currentLanguage}_seo_description`);
    expect(document.documentElement.lang).toBe(currentLanguage);
    expect(document.head.querySelectorAll('meta[name="description"]')).toHaveLength(1);
  });
});

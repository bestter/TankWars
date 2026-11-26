// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { HelmetProvider } from 'react-helmet-async';
import { SEO } from '../SEO';
import indexHtml from '../../../index.html?raw';
import robotsText from '../../../public/robots.txt?raw';
import sitemapXml from '../../../public/sitemap.xml?raw';

let currentLanguage = 'fr';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => `trans_${key}`,
    i18n: {
      language: currentLanguage,
    },
  }),
}));

describe('static SEO metadata', () => {
  it('publishes the canonical URL and share card in the initial HTML', () => {
    const canonical = 'https://tankwars-game.com/';
    const html = new DOMParser().parseFromString(indexHtml, 'text/html');
    const sitemap = new DOMParser().parseFromString(sitemapXml, 'application/xml');

    expect(html.head.querySelector('link[rel="canonical"]')?.getAttribute('href')).toBe(canonical);
    expect(html.head.querySelector('meta[property="og:url"]')?.getAttribute('content')).toBe(canonical);
    expect(html.head.querySelector('meta[property="og:title"]')?.getAttribute('content')).toBe(html.title);
    expect(html.head.querySelector('meta[property="og:image"]')?.getAttribute('content')).toBe(`${canonical}icon-512.png`);
    expect(html.head.querySelector('meta[name="twitter:card"]')?.getAttribute('content')).toBe('summary');
    expect(html.head.querySelector('meta[name="twitter:image"]')?.getAttribute('content')).toBe(`${canonical}icon-512.png`);
    expect(robotsText).toContain(`Sitemap: ${canonical}sitemap.xml`);
    expect(sitemap.querySelector('loc')?.textContent).toBe(canonical);
  });
});

describe('SEO component', () => {
  beforeEach(() => {
    currentLanguage = 'fr';
  });

  afterEach(cleanup);

  it.each(['fr', 'en'])('localizes the page metadata for %s without duplicating static tags', (language) => {
    currentLanguage = language;

    render(
      <HelmetProvider>
        <SEO titleKey="seo_title" descriptionKey="seo_description" />
      </HelmetProvider>
    );

    expect(document.title).toBe('trans_seo_title');
    expect(document.querySelector('meta[name="description"]')?.getAttribute('content')).toBe('trans_seo_description');
    expect(document.documentElement.lang).toBe(language);
    expect(document.querySelector('link[rel="canonical"]')).toBeNull();
    expect(document.querySelector('meta[property^="og:"]')).toBeNull();
    expect(document.querySelector('meta[name^="twitter:"]')).toBeNull();
  });
});

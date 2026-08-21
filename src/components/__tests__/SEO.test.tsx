// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { HelmetProvider } from 'react-helmet-async';
import { SEO } from '../SEO';

let currentLanguage = 'fr';

// Mock react-i18next
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => `trans_${key}`,
    i18n: {
      language: currentLanguage,
    },
  }),
}));

describe('SEO component', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cleanup();
    currentLanguage = 'fr';
  });

  afterEach(() => {
    cleanup();
  });

  it('injects page title, description, canonical link, and OpenGraph/Twitter tags', () => {
    render(
      <HelmetProvider>
        <SEO titleKey="seo_title" descriptionKey="seo_description" />
      </HelmetProvider>
    );

    // Title
    expect(document.title).toBe('trans_seo_title');

    // Description
    const metaDesc = document.querySelector('meta[name="description"]');
    expect(metaDesc?.getAttribute('content')).toBe('trans_seo_description');

    // Canonical link
    const canonicalLink = document.querySelector('link[rel="canonical"]');
    expect(canonicalLink?.getAttribute('href')).toBe('https://tankwars.pages.dev');

    // Alternate links
    const altEn = document.querySelector('link[rel="alternate"][hreflang="en"]');
    const altFr = document.querySelector('link[rel="alternate"][hreflang="fr"]');
    const altDefault = document.querySelector('link[rel="alternate"][hreflang="x-default"]');
    expect(altEn?.getAttribute('href')).toBe('https://tankwars.pages.dev');
    expect(altFr?.getAttribute('href')).toBe('https://tankwars.pages.dev');
    expect(altDefault?.getAttribute('href')).toBe('https://tankwars.pages.dev');

    // OpenGraph
    const ogTitle = document.querySelector('meta[property="og:title"]');
    const ogDesc = document.querySelector('meta[property="og:description"]');
    const ogUrl = document.querySelector('meta[property="og:url"]');
    const ogImage = document.querySelector('meta[property="og:image"]');
    expect(ogTitle?.getAttribute('content')).toBe('trans_seo_title');
    expect(ogDesc?.getAttribute('content')).toBe('trans_seo_description');
    expect(ogUrl?.getAttribute('content')).toBe('https://tankwars.pages.dev');
    expect(ogImage?.getAttribute('content')).toBe('https://tankwars.pages.dev/og-image.jpg');

    // Twitter Card
    const twitterCard = document.querySelector('meta[name="twitter:card"]');
    const twitterTitle = document.querySelector('meta[name="twitter:title"]');
    expect(twitterCard?.getAttribute('content')).toBe('summary_large_image');
    expect(twitterTitle?.getAttribute('content')).toBe('trans_seo_title');

    // HTML lang attribute
    expect(document.documentElement.lang).toBe('fr');
  });

  it('supports custom path parameter and english language attribute', () => {
    currentLanguage = 'en';

    render(
      <HelmetProvider>
        <SEO titleKey="seo_title" descriptionKey="seo_description" path="/play-online" />
      </HelmetProvider>
    );

    const canonicalLink = document.querySelector('link[rel="canonical"]');
    expect(canonicalLink?.getAttribute('href')).toBe('https://tankwars.pages.dev/play-online');

    const ogUrl = document.querySelector('meta[property="og:url"]');
    expect(ogUrl?.getAttribute('content')).toBe('https://tankwars.pages.dev/play-online');

    const twitterUrl = document.querySelector('meta[name="twitter:url"]');
    expect(twitterUrl?.getAttribute('content')).toBe('https://tankwars.pages.dev/play-online');

    expect(document.documentElement.lang).toBe('en');
  });
});

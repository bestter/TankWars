// src/components/SEO.tsx
import React from 'react';
import { Helmet } from 'react-helmet-async';
import { useTranslation } from 'react-i18next';
// On importe le type de clé issu de la configuration globale
import type { ParseKeys } from 'i18next';

interface SEOProps {
    // ParseKeys force la prop à être l'une des clés réelles de tes fichiers de traduction
    titleKey: ParseKeys;
    descriptionKey: ParseKeys;
    path?: string;
}

export const SEO: React.FC<SEOProps> = ({ titleKey, descriptionKey, path = '' }) => {
    const { t, i18n } = useTranslation();

    const baseUrl = "https://tankwars.pages.dev";
    const currentUrl = `${baseUrl}${path}`;
    const currentLang = i18n.language.startsWith('fr') ? 'fr' : 'en';

    return (
        <Helmet>
            <html lang={currentLang} />
            {/* On force le casting en string car le retour de ParseKeys peut déstabiliser certains types natifs de Helmet */}
            <title>{t(titleKey)}</title>
            <meta name="description" content={t(descriptionKey)} />
            <link rel="canonical" href={currentUrl} />

            <link rel="alternate" hrefLang="en" href={`${baseUrl}`} />
            <link rel="alternate" hrefLang="fr" href={`${baseUrl}`} />
            <link rel="alternate" hrefLang="x-default" href={`${baseUrl}`} />

            <meta property="og:type" content="website" />
            <meta property="og:url" content={currentUrl} />
            <meta property="og:title" content={t(titleKey)} />
            <meta property="og:description" content={t(descriptionKey)} />
            <meta property="og:image" content={`${baseUrl}/og-image.jpg`} />

            <meta name="twitter:card" content="summary_large_image" />
            <meta name="twitter:url" content={currentUrl} />
            <meta name="twitter:title" content={t(titleKey)} />
            <meta name="twitter:description" content={t(descriptionKey)} />
            <meta name="twitter:image" content={`${baseUrl}/og-image.jpg`} />
        </Helmet>
    );
};
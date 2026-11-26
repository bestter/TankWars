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
}

export const SEO: React.FC<SEOProps> = ({ titleKey, descriptionKey }) => {
    const { t, i18n } = useTranslation();

    const currentLang = i18n.language.startsWith('fr') ? 'fr' : 'en';

    return (
        <Helmet>
            <html lang={currentLang} />
            {/* On force le casting en string car le retour de ParseKeys peut déstabiliser certains types natifs de Helmet */}
            <title>{t(titleKey)}</title>
            <meta name="description" content={t(descriptionKey)} />
        </Helmet>
    );
};

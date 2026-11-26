import { useEffect } from 'react';
import type { FC } from 'react';
import { Helmet } from 'react-helmet-async';
import { useTranslation } from 'react-i18next';
import type { ParseKeys } from 'i18next';

interface SEOProps {
  titleKey: ParseKeys;
  descriptionKey: ParseKeys;
}

export const SEO: FC<SEOProps> = ({ titleKey, descriptionKey }) => {
  const { t, i18n } = useTranslation();
  const currentLang = i18n.language?.startsWith('fr') ? 'fr' : 'en';
  const description = t(descriptionKey);

  useEffect(() => {
    // L'HTML initial fournit déjà cette balise aux robots sans JavaScript.
    let meta = document.head.querySelector<HTMLMetaElement>('meta[name="description"]');
    if (!meta) {
      meta = document.createElement('meta');
      meta.name = 'description';
      document.head.append(meta);
    }
    meta.content = description;
  }, [description]);

  return (
    <Helmet>
      <html lang={currentLang} />
      <title>{t(titleKey)}</title>
    </Helmet>
  );
};

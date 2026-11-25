import { useTranslation } from "react-i18next";
import { VGA_PALETTE } from "../types/game";

export function LanguageSwitcher() {
  const { t, i18n } = useTranslation();
  const currentLang = i18n.language || "en";
  const isFr = currentLang.startsWith("fr");
  const isEn = currentLang.startsWith("en");

  const toggleLang = (lang: string) => {
    i18n.changeLanguage(lang);
  };

  return (
    <div
      className="language-switcher"
      role="group"
      aria-label={t("language_switcher_label")}
    >
      <button
        type="button"
        lang="fr"
        aria-pressed={isFr}
        className={`language-switcher-btn${isFr ? " active" : ""}`}
        onClick={() => toggleLang("fr")}
        style={{
          background: isFr ? VGA_PALETTE.GREEN : "#111",
          color: isFr ? "#000" : VGA_PALETTE.GRAY,
        }}
      >
        FR
      </button>
      <button
        type="button"
        lang="en"
        aria-pressed={isEn}
        className={`language-switcher-btn${isEn ? " active" : ""}`}
        onClick={() => toggleLang("en")}
        style={{
          background: isEn ? VGA_PALETTE.GREEN : "#111",
          color: isEn ? "#000" : VGA_PALETTE.GRAY,
        }}
      >
        EN
      </button>
    </div>
  );
}

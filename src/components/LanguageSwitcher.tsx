import { useTranslation } from "react-i18next";
import { VGA_PALETTE } from "../types/game";

export function LanguageSwitcher() {
  const { i18n } = useTranslation();
  const currentLang = i18n.language || "en";

  const toggleLang = (lang: string) => {
    i18n.changeLanguage(lang);
  };

  return (
    <div
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "4px",
        padding: "2px",
        background: "#000000",
        border: `1px solid ${VGA_PALETTE.GRAY}`,
        fontFamily: "monospace",
        fontSize: "12px",
      }}
    >
      <button
        type="button"
        onClick={() => toggleLang("fr")}
        style={{
          background: currentLang.startsWith("fr") ? VGA_PALETTE.GREEN : "#111",
          color: currentLang.startsWith("fr") ? "#000" : VGA_PALETTE.GRAY,
          border: "none",
          padding: "2px 6px",
          cursor: "pointer",
          fontWeight: "bold",
          fontSize: "12px",
        }}
      >
        FR
      </button>
      <button
        type="button"
        onClick={() => toggleLang("en")}
        style={{
          background: currentLang.startsWith("en") ? VGA_PALETTE.GREEN : "#111",
          color: currentLang.startsWith("en") ? "#000" : VGA_PALETTE.GRAY,
          border: "none",
          padding: "2px 6px",
          cursor: "pointer",
          fontWeight: "bold",
          fontSize: "12px",
        }}
      >
        EN
      </button>
    </div>
  );
}

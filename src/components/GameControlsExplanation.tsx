import { useTranslation } from "react-i18next";

export function GameControlsExplanation() {
  const { t } = useTranslation();
  return (
    <div className="game-controls-explanation">
      <strong>{t("controls_title")}</strong> {t("controls_body")}
      <br />
      {t("controls_explanation")}
    </div>
  );
}

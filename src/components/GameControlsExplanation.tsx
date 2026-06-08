import { useTranslation } from "react-i18next";
import { VGA_PALETTE } from "../types/game";

export function GameControlsExplanation() {
  const { t } = useTranslation();
  return (
    <div
      style={{ color: VGA_PALETTE.GRAY, fontSize: 12, textAlign: "center" }}
    >
      <strong>{t("controls_title")}</strong> {t("controls_body")}
      <br />
      {t("controls_explanation")}
    </div>
  );
}

import { useTranslation } from "react-i18next";
import { formatWindDisplay } from "../game/wind";
import { VGA_PALETTE } from "../types/game";

const WIND_DIR_KEYS: Record<string, "wind_dir_calm" | "wind_dir_west" | "wind_dir_east"> = {
  calm: "wind_dir_calm",
  west: "wind_dir_west",
  east: "wind_dir_east",
};

export interface WindBannerProps {
  windForce: number;
}

export function WindBanner({ windForce }: WindBannerProps) {
  const { t } = useTranslation();
  const info = formatWindDisplay(windForce);
  const barMax = 52;
  const fill =
    info.direction === "CALM" ? 0 : Math.min(1, info.strength / barMax);
  const barWidth = Math.round(fill * 120);

  return (
    <div
      aria-label={t("wind_aria_label", { label: t(WIND_DIR_KEYS[info.label.toLowerCase()] || "wind_dir_calm"), strength: info.strength })}
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        right: 0,
        zIndex: 6,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        gap: 10,
        padding: "5px 12px",
        background: "rgba(0, 0, 0, 0.72)",
        borderBottom: `2px solid ${VGA_PALETTE.CYAN}`,
        fontFamily: "monospace",
        fontSize: 13,
        fontWeight: "bold",
        pointerEvents: "none",
        letterSpacing: "0.06em",
      }}
    >
      <span style={{ color: VGA_PALETTE.CYAN }}>{t("wind_title")}</span>
      <span
        style={{
          color:
            info.direction === "CALM" ? VGA_PALETTE.GRAY : VGA_PALETTE.YELLOW,
          minWidth: 28,
          fontSize: 18,
          lineHeight: 1,
        }}
      >
        {info.arrow}
      </span>
      <span style={{ color: VGA_PALETTE.WHITE }}>{t(WIND_DIR_KEYS[info.label.toLowerCase()] || "wind_dir_calm")}</span>
      {info.direction !== "CALM" && (
        <>
          <span style={{ color: VGA_PALETTE.GREEN }}>{info.strength}</span>
          <div
            style={{
              width: 120,
              height: 8,
              background: VGA_PALETTE.DARK_GRAY,
              border: `1px solid ${VGA_PALETTE.GRAY}`,
            }}
          >
            <div
              style={{
                width: barWidth,
                height: "100%",
                background:
                  info.strength > 36
                    ? VGA_PALETTE.RED
                    : info.strength > 20
                      ? VGA_PALETTE.YELLOW
                      : VGA_PALETTE.GREEN,
              }}
            />
          </div>
        </>
      )}
      {info.direction === "CALM" && (
        <span style={{ color: VGA_PALETTE.GRAY, fontSize: 12 }}>{t("wind_no_drift")}</span>
      )}
    </div>
  );
}

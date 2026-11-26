import { useTranslation } from "react-i18next";
import type { Color } from "../types/game";

export interface ColorPickerProps {
  /** The currently selected color for this player */
  selectedColor: Color;
  /** Callback when a new color is selected */
  onColorSelect: (color: Color) => void;
  /** Set of unavailable or already used colors (selectedColor is automatically excluded) */
  unavailableColors: ReadonlySet<Color>;
  /** The full pool of colors to choose from */
  colorPool: readonly Color[];
  /** Accessible group label for this player's color picker */
  groupLabel?: string;
}

export function ColorPicker({
  selectedColor,
  onColorSelect,
  unavailableColors,
  colorPool,
  groupLabel,
}: ColorPickerProps) {
  const { t } = useTranslation();

  return (
    <div
      className="retro-color-picker"
      role="group"
      aria-label={groupLabel ?? t("color_picker_group_label")}
    >
      {colorPool.map((color) => {
        const isSelected = color === selectedColor;
        const isUnavailable = color !== selectedColor && unavailableColors.has(color);
        const btnClass = `retro-color-swatch-btn${isSelected ? " selected" : ""}${isUnavailable ? " unavailable" : ""}`;

        return (
          <button
            key={color}
            type="button"
            disabled={isUnavailable}
            aria-pressed={isSelected}
            className={btnClass}
            onClick={() => {
              if (!isUnavailable) {
                onColorSelect(color);
              }
            }}
            style={{
              backgroundColor: color,
              boxShadow: isSelected ? `0 0 5px ${color}` : "none",
            }}
            title={
              isUnavailable
                ? t("color_unavailable_title")
                : t("color_select_title", { color })
            }
            aria-label={
              isUnavailable
                ? t("color_unavailable_label", { color })
                : t("color_select_label", { color })
            }
          >
            {isUnavailable && (
              <span
                className="retro-color-swatch-unavailable-mark"
                aria-hidden="true"
              >
                ✕
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

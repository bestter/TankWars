import { VGA_PALETTE, type Color } from "../types/game";

export interface ColorPickerProps {
  /** The currently selected color for this player */
  selectedColor: Color;
  /** Callback when a new color is selected */
  onColorSelect: (color: Color) => void;
  /** Set of colors selected by other players (for mutual exclusion) */
  unavailableColors: Set<Color>;
  /** The full pool of colors to choose from */
  colorPool: readonly Color[];
}

export function ColorPicker({
  selectedColor,
  onColorSelect,
  unavailableColors,
  colorPool,
}: ColorPickerProps) {
  return (
    <div
      style={{
        display: "flex",
        gap: "4px",
        alignItems: "center",
        flexWrap: "wrap",
      }}
    >
      {colorPool.map((color) => {
        const isSelected = color === selectedColor;
        const isUnavailable = unavailableColors.has(color);

        return (
          <button
            key={color}
            type="button"
            disabled={isUnavailable}
            className="retro-color-swatch-btn"
            onClick={() => {
              if (!isUnavailable) {
                onColorSelect(color);
              }
            }}
            style={{
              backgroundColor: color,
              width: isSelected ? "16px" : "12px",
              height: isSelected ? "14px" : "10px",
              border: isSelected
                ? `2px solid ${VGA_PALETTE.WHITE}`
                : isUnavailable
                  ? "1px dashed #333333"
                  : "1px solid #555555",
              cursor: isUnavailable ? "not-allowed" : "pointer",
              opacity: isUnavailable ? 0.2 : isSelected ? 1.0 : 0.7,
              boxShadow: isSelected ? `0 0 5px ${color}` : "none",
              transform: isSelected ? "scale(1.15)" : "none",
            }}
            title={
              isUnavailable
                ? "Couleur déjà sélectionnée par un autre joueur"
                : `Choisir la couleur ${color}`
            }
            aria-label={
              isUnavailable
                ? `Couleur ${color} indisponible`
                : `Choisir la couleur ${color}`
            }
          >
            {isUnavailable && (
              <span
                style={{
                  position: "absolute",
                  inset: 0,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  color: "#FF3333",
                  fontSize: "9px",
                  lineHeight: "9px",
                  fontWeight: "bold",
                  pointerEvents: "none",
                }}
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

import { useTranslation } from "react-i18next";
import type { PlayerConfig } from "./MainMenu";
import { type Color } from "../types/game";
import { ColorPicker } from "./ColorPicker";
import { TankPreview } from "./TankPreview";

export interface PlayerConfigRowProps {
  cfg: PlayerConfig;
  index: number;
  unavailableColors: Set<Color>;
  colorPool: readonly Color[];
  nameInputRef: (el: HTMLInputElement | null) => void;
  onNameChange: (index: number, value: string) => void;
  onColorSelect: (index: number, newColor: Color) => void;
  onTypeChange: (index: number, isHuman: boolean) => void;
  onUpdatePlayer: (index: number, patch: Partial<PlayerConfig>) => void;
}

export function PlayerConfigRow({
  cfg,
  index,
  unavailableColors,
  colorPool,
  nameInputRef,
  onNameChange,
  onColorSelect,
  onTypeChange,
  onUpdatePlayer,
}: PlayerConfigRowProps) {
  const { t } = useTranslation();
  const color = cfg.color;
  const isHuman = cfg.isHuman;

  return (
    <div
      className="retro-player-row"
      style={{ display: "flex", alignItems: "center", gap: "8px" }}
    >
      {/* Aperçu miniature du tank */}
      <TankPreview color={color} />

      {/* Nom du joueur (éditable) */}
      <input
        ref={nameInputRef}
        type="text"
        className="retro-input"
        value={cfg.name}
        maxLength={16}
        onChange={(e) => onNameChange(index, e.target.value)}
        placeholder={t("player_name_placeholder", { num: index + 1 })}
        aria-label={t("player_name_aria_label", { num: index + 1 })}
      />

      {/* Sélecteur de couleur avec exclusion mutuelle */}
      <ColorPicker
        selectedColor={color}
        onColorSelect={(newColor) => onColorSelect(index, newColor)}
        unavailableColors={unavailableColors}
        colorPool={colorPool}
      />

      {/* Select Controller Type (Humain, IA Simple, IA OK, IA Sniper, IA Expert) */}
      <select
        className="retro-input retro-player-select"
        style={{
          color: isHuman ? "#55FF55" : "#FFAA00",
          border: `1px solid ${isHuman ? "#55FF55" : "#FFAA00"}`,
        }}
        value={isHuman ? "human" : (cfg.aiProfile ?? "v1-random")}
        onChange={(e) => {
          const val = e.target.value;
          if (val === "human") {
            onTypeChange(index, true);
          } else {
            onUpdatePlayer(index, {
              isHuman: false,
              aiProfile: val as
                | "v1-random"
                | "v2-heuristic"
                | "v3-sniper"
                | "v4-smart",
            });
          }
        }}
        aria-label={t("controller_type_aria_label", { num: index + 1 })}
      >
        <option
          value="human"
          style={{ color: "#55FF55", background: "#000000" }}
        >
          {t("controller_human")}
        </option>
        <option
          value="v1-random"
          style={{ color: "#FFAA00", background: "#000000" }}
        >
          {t("controller_ai_simple")}
        </option>
        <option
          value="v2-heuristic"
          style={{ color: "#FFAA00", background: "#000000" }}
        >
          {t("controller_ai_ok")}
        </option>
        <option
          value="v3-sniper"
          style={{ color: "#FFAA00", background: "#000000" }}
        >
          {t("controller_ai_sniper")}
        </option>
        <option
          value="v4-smart"
          style={{ color: "#FFAA00", background: "#000000" }}
        >
          {t("controller_ai_expert")}
        </option>
      </select>

      {/* Compact Status Indicator */}
      <span
        style={{
          fontSize: 12,
          color: isHuman ? "#55FF55" : "#FFAA00",
          marginLeft: 2,
          minWidth: 32,
          textAlign: "center",
        }}
      >
        {isHuman
          ? "P"
          : cfg.aiProfile === "v2-heuristic"
            ? "OK"
            : cfg.aiProfile === "v3-sniper"
              ? "SNIP"
              : cfg.aiProfile === "v4-smart"
                ? "EXPT"
                : "CPU"}
      </span>
    </div>
  );
}

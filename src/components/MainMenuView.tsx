import type { MouseEventHandler } from "react";
import { useTranslation } from "react-i18next";
import { version } from "../../package.json";
import type { Color } from "../types/game";
import type { PlayerConfig } from "./MainMenu";
import { PlayerConfigList } from "./PlayerConfigList";
import type { PlayerController } from "./playerControllerUi";

interface MainMenuViewProps {
  numPlayers: 2 | 3 | 4;
  playerConfigs: readonly PlayerConfig[];
  colorPool: readonly Color[];
  nameErrorIds: ReadonlySet<string>;
  emptyNameErrorIds: ReadonlySet<string>;
  nameConflictSourceIds: ReadonlySet<string>;
  canStart: boolean;
  onMenuClickCapture: MouseEventHandler<HTMLDivElement>;
  onNumPlayersChange: (count: 2 | 3 | 4) => void;
  onNameInputRef: (index: number, el: HTMLInputElement | null) => void;
  onNameChange: (index: number, value: string) => void;
  onNameFocus: (index: number) => void;
  onNameBlur: (index: number) => void;
  onColorSelect: (index: number, color: Color) => void;
  onControllerChange: (index: number, controller: PlayerController) => void;
  onStart: () => void;
  onPlayOnline?: () => void;
}

export function MainMenuView({
  numPlayers,
  playerConfigs,
  colorPool,
  nameErrorIds,
  emptyNameErrorIds,
  nameConflictSourceIds,
  canStart,
  onMenuClickCapture,
  onNumPlayersChange,
  onNameInputRef,
  onNameChange,
  onNameFocus,
  onNameBlur,
  onColorSelect,
  onControllerChange,
  onStart,
  onPlayOnline,
}: MainMenuViewProps) {
  const { t } = useTranslation();

  return (
    <div className="retro-menu-container" onClickCapture={onMenuClickCapture}>
      <div className="retro-menu-frame">
        <div className="retro-menu-inner">
          <h1 className="retro-title">{t("main_title")}</h1>
          <p className="retro-subtitle" style={{ whiteSpace: "pre-line" }}>
            {t("retro_subtitle")}
          </p>

          <div className="retro-section">{t("battle_configuration")}</div>
          <div style={{ marginBottom: 10 }}>
            <span style={{ color: "#AAAAAA", fontSize: 12, marginRight: 8 }}>
              {t("num_players")}
            </span>
            {[2, 3, 4].map((count) => (
              <button
                key={count}
                type="button"
                className={`retro-num-btn ${count === numPlayers ? "active" : ""}`}
                onClick={() => onNumPlayersChange(count as 2 | 3 | 4)}
              >
                {count}
              </button>
            ))}
          </div>

          <div style={{ marginBottom: 6 }}>
            <PlayerConfigList
              playerConfigs={playerConfigs}
              colorPool={colorPool}
              nameErrorIds={nameErrorIds}
              emptyNameErrorIds={emptyNameErrorIds}
              nameConflictSourceIds={nameConflictSourceIds}
              onNameInputRef={onNameInputRef}
              onNameChange={onNameChange}
              onNameFocus={onNameFocus}
              onNameBlur={onNameBlur}
              onColorSelect={onColorSelect}
              onControllerChange={onControllerChange}
            />
          </div>

          <div className="retro-color-picker-help">
            {t("color_picker_help_1")}
            <br />
            {t("color_picker_help_2")}
          </div>

          <div style={{ textAlign: "center" }}>
            <button
              type="button"
              className="retro-start-btn"
              onClick={onStart}
              disabled={!canStart}
              style={{
                opacity: canStart ? 1 : 0.5,
                cursor: canStart ? "pointer" : "not-allowed",
              }}
            >
              {t("start_battle_button")}
            </button>

            <div style={{ marginTop: 10 }}>
              <button
                type="button"
                className="retro-online-btn"
                onClick={() => onPlayOnline?.()}
              >
                {t("online_multiplayer_button")}
              </button>
            </div>
          </div>

          <div className="retro-legal">
            {t("legal_footer")} | v{version}
          </div>
        </div>
      </div>
    </div>
  );
}

import { memo, useId } from "react";
import { useTranslation } from "react-i18next";
import {
  formatStatusNumber,
  playerStatusProfileKey,
  visibleStatusWeapons,
  type PlayerStatusCard,
} from "./playerStatus";
import { WEAPON_I18N_KEYS, weaponShortLabel } from "./weaponShortLabel";

export interface PlayerStatusListProps {
  readonly players: readonly PlayerStatusCard[];
  readonly currentPlayerId: string;
  readonly gameMode: "local" | "online";
}

export const PlayerStatusList = memo(function PlayerStatusList({
  players,
  currentPlayerId,
  gameMode,
}: PlayerStatusListProps) {
  const { t, i18n } = useTranslation();
  const titleId = useId();
  const language = i18n.resolvedLanguage ?? i18n.language ?? "fr";

  return (
    <section className="player-status" aria-labelledby={titleId}>
      <p id={titleId} className="player-status-title">
        {t("player_status_title")}
      </p>
      <ul className="player-status-list">
        {players.map((player) => {
          const current = player.id === currentPlayerId;
          const weapons = visibleStatusWeapons(player.inventory);
          return (
            <li
              key={player.id}
              className="player-status-card"
              style={{ borderColor: current ? player.color : "#555555" }}
            >
              <div className="player-status-head">
                <span
                  className="player-status-swatch"
                  aria-hidden="true"
                  style={{ backgroundColor: player.color }}
                />
                <span className="player-status-name" style={{ color: player.color }}>
                  {player.name}
                </span>
                <span className="player-status-profile">{t(playerStatusProfileKey(player))}</span>
                {current && <span className="player-status-you">{t("player_status_you")}</span>}
              </div>
              <p className="player-status-meters">
                <span>
                  {t("player_status_health", {
                    current: formatStatusNumber(player.health, language, "current", "health"),
                    max: formatStatusNumber(player.maxHealth, language, "max", "health"),
                  })}
                </span>
                <span>
                  {t("player_status_shield", {
                    current: formatStatusNumber(player.shield, language, "current", "shield"),
                    max: formatStatusNumber(player.maxShield, language, "max", "shield"),
                  })}
                </span>
              </p>
              <div className="player-status-weapons">
                {weapons.map((weapon) => {
                  const quantity = weapon.quantity === null ? "∞" : String(weapon.quantity);
                  return (
                    <span key={weapon.id} className="player-status-chip">
                      <span aria-hidden="true">{weaponShortLabel(weapon.id)}:{quantity}</span>
                      <span className="visually-hidden">{t(WEAPON_I18N_KEYS[weapon.id])} {quantity}</span>
                    </span>
                  );
                })}
              </div>
              {!current && gameMode !== "online" && (
                <button
                  type="button"
                  className="player-status-lock"
                  disabled
                  data-lock-target={player.id}
                  aria-label={t("player_status_lock_name", { name: player.name })}
                >
                  {t("player_status_lock")}
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
});

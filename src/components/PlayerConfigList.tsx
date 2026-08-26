import { useTranslation } from "react-i18next";
import type { Color } from "../types/game";
import type { PlayerConfig } from "./MainMenu";
import { PlayerConfigRow } from "./PlayerConfigRow";
import { getNameConflictIds } from "./playerNameUi";
import type { PlayerController } from "./playerControllerUi";

interface PlayerConfigListProps {
  playerConfigs: readonly PlayerConfig[];
  colorPool: readonly Color[];
  nameErrorIds: ReadonlySet<string>;
  emptyNameErrorIds?: ReadonlySet<string>;
  nameConflictSourceIds: ReadonlySet<string>;
  onNameInputRef: (index: number, el: HTMLInputElement | null) => void;
  onNameChange: (index: number, value: string) => void;
  onNameFocus: (index: number) => void;
  onNameBlur: (index: number) => void;
  onColorSelect: (index: number, color: Color) => void;
  onControllerChange: (index: number, controller: PlayerController) => void;
}

export function PlayerConfigList({
  playerConfigs,
  colorPool,
  nameErrorIds,
  emptyNameErrorIds,
  nameConflictSourceIds,
  onNameInputRef,
  onNameChange,
  onNameFocus,
  onNameBlur,
  onColorSelect,
  onControllerChange,
}: PlayerConfigListProps) {
  const { t } = useTranslation();
  const usedColors = new Set(playerConfigs.map((player) => player.color));
  const playerNumberById = new Map<string, number>();
  for (let index = 0; index < playerConfigs.length; index += 1) {
    const player = playerConfigs[index];
    if (player) playerNumberById.set(player.id, index + 1);
  }

  return playerConfigs.map((cfg, index) => {
    const unavailableColors = new Set(usedColors);
    unavailableColors.delete(cfg.color);
    const conflictIds = getNameConflictIds(playerConfigs, cfg.id);
    const hasNameError = nameErrorIds.has(cfg.id);
    const isEmptyError = emptyNameErrorIds?.has(cfg.id) ?? false;
    const conflictNumbers: number[] = [];
    for (const conflictId of conflictIds) {
      const playerNumber = playerNumberById.get(conflictId);
      if (playerNumber !== undefined) conflictNumbers.push(playerNumber);
    }

    let errorMessage: string | undefined;
    if (hasNameError) {
      if (isEmptyError) {
        errorMessage = t("player_name_empty_error");
      } else if (conflictNumbers.length > 0) {
        errorMessage = t("player_name_duplicate_error", {
          players: conflictNumbers.join(", "),
        });
      }
    }

    return (
      <PlayerConfigRow
        key={cfg.id}
        cfg={cfg}
        index={index}
        unavailableColors={unavailableColors}
        colorPool={colorPool}
        nameInputRef={(el) => onNameInputRef(index, el)}
        nameError={errorMessage}
        isNameConflictSource={
          !hasNameError && nameConflictSourceIds.has(cfg.id)
        }
        onNameChange={onNameChange}
        onNameFocus={onNameFocus}
        onNameBlur={onNameBlur}
        onColorSelect={onColorSelect}
        onControllerChange={onControllerChange}
      />
    );
  });
}

/**
 * Bestter's TankWars - MainMenu React Component (src/components/MainMenu.tsx)
 *
 * Écran d'accueil rétro DOS/VGA :
 * - Fond noir + bordure double ligne style ancien terminal
 * - Titre géant clignotant jaune VGA (#FFFF55 / blanc)
 * - Configuration joueurs (2-4) : nom + type Humain / IA Simple (Mr. Simple) / IA OK (smarter v2)
 * - Attribution auto de couleurs VGA uniques (palette partagée)
 * - Au clic START : fabrique les Player[] valides + invoke callback
 *
 * Le parent (App) gère le basculement phase MENU → COMBAT et le montage du GameCanvas.
 *
 * Respecte guidelines :
 * - React hooks + TS strict (zéro any)
 * - State React pur (pas de mutation canvas)
 * - Couleurs depuis VGA_PALETTE
 */

import { useState, useRef, type MouseEvent as ReactMouseEvent } from "react";
import { useTranslation } from "react-i18next";
import type { Player, AiProfile } from "../types/player";
import { VGA_PALETTE } from "../types/game";
type Color = (typeof VGA_PALETTE)[keyof typeof VGA_PALETTE];
import { DEFAULT_INVENTORY } from "../types/weapon";
import { MainMenuView } from "./MainMenuView";
import {
  AI_PROFILE_UI,
  DEFAULT_AI_PROFILE,
  type PlayerController,
} from "./playerControllerUi";
import { getUniqueAiName } from "./playerNameUi";
import { usePlayerNameValidation } from "./usePlayerNameValidation";

export interface MainMenuProps {
  /** Appelé avec les joueurs initialisés (positions placeholder, spawn fait par TankManager/Engine) */
  onStartGame: (players: Player[]) => void;
  /** Ouvre le lobby multijoueur en ligne (création / URLs) — parallèle au hotseat local */
  onPlayOnline?: () => void;
}

export interface PlayerConfig {
  name: string;
  isHuman: boolean;
  color: Color;
  /** stable identifier for React list keys (avoids array index keys) */
  id: string;
  /** Only meaningful when !isHuman. Defaults to v1 for "IA SIMPLE" (Mr. Simple). */
  aiProfile?: AiProfile;
}

/** Couleurs tanks jouables (palette VGA rétro classique + extensions néon haute visibilité)
 *  Chaque couleur est distincte et offre un excellent contraste sur fond sombre.
 */
const TANK_COLOR_POOL: readonly Color[] = [
  VGA_PALETTE.BLUE, // #5555FF - Joueur 1 (Bleu par défaut)
  VGA_PALETTE.RED, // #FF5555 - Joueur 2 (Rouge par défaut)
  VGA_PALETTE.ELECTRIC_CYAN, // #00F7FF
  VGA_PALETTE.FLASH_GREEN, // #00FF7F
  VGA_PALETTE.NEON_PINK, // #FF1A8C
  VGA_PALETTE.CYBER_YELLOW, // #D7FF00
  VGA_PALETTE.FLUO_ORANGE, // #FF8C00
  VGA_PALETTE.VOLT_PURPLE, // #B300FF
] as const;

export function MainMenu({ onStartGame, onPlayOnline }: MainMenuProps) {
  const { t } = useTranslation();

  const getDefaultHumanName = (index: number): string => {
    if (index === 0) return t("default_player_name_1");
    return t("default_player_name_n", { num: index + 1 });
  };

  const getDefaultAiName = (
    profile: AiProfile,
    configs: readonly PlayerConfig[],
    index: number,
  ): string => {
    const baseName = t(AI_PROFILE_UI[profile].nameKey);
    return getUniqueAiName(baseName, profile, configs, index);
  };

  const [numPlayers, setNumPlayers] = useState<2 | 3 | 4>(2);
  const [playerConfigs, setPlayerConfigs] = useState<PlayerConfig[]>(() => {
    const initialConfigs: PlayerConfig[] = [
      {
        name: getDefaultHumanName(0),
        isHuman: true,
        color: TANK_COLOR_POOL[0],
        id: crypto.randomUUID(),
      },
    ];
    initialConfigs.push({
      name: getDefaultAiName(
        DEFAULT_AI_PROFILE,
        initialConfigs,
        initialConfigs.length,
      ),
      isHuman: false,
      color: TANK_COLOR_POOL[1],
      id: crypto.randomUUID(),
      aiProfile: DEFAULT_AI_PROFILE,
    });
    return initialConfigs;
  });

  // Refs for name inputs, to auto-focus/select when switching a player to Human
  const nameInputRefs = useRef<(HTMLInputElement | null)[]>([]);
  const nameValidation = usePlayerNameValidation(playerConfigs);

  // (couleurs maintenant gérées par playerConfigs, sélectionnables par l'utilisateur)

  // Synchronise le tableau de configs quand on change le nombre de joueurs
  const changeNumPlayers = (n: 2 | 3 | 4): void => {
    if (n === numPlayers) return;

    setNumPlayers(n);

    setPlayerConfigs((prev) => {
      const next = [...prev];

      // Ajouter des configs par défaut si on augmente
      while (next.length < n) {
        const idx = next.length;
        const defaultIsHuman = idx === 0; // premier = humain par défaut
        const usedColors = new Set(next.map((p) => p.color));
        const available = TANK_COLOR_POOL.filter((c) => !usedColors.has(c));
        const newColor =
          available[0] ?? TANK_COLOR_POOL[idx % TANK_COLOR_POOL.length];
        const defaultAiProfile = DEFAULT_AI_PROFILE;
        const newCfg: PlayerConfig = {
          name: defaultIsHuman
            ? getDefaultHumanName(idx)
            : getDefaultAiName(defaultAiProfile, next, idx),
          isHuman: defaultIsHuman,
          color: newColor,
          id: `p-${crypto.randomUUID()}-${idx}`,
        };
        if (!defaultIsHuman) {
          newCfg.aiProfile = defaultAiProfile;
        }
        next.push(newCfg);
      }

      // Tronquer si on diminue
      return next.slice(0, n);
    });
  };

  // Mise à jour immutable d'un champ d'un joueur
  const updatePlayer = (index: number, patch: Partial<PlayerConfig>): void => {
    setPlayerConfigs((prev) =>
      prev.map((cfg, i) => (i === index ? { ...cfg, ...patch } : cfg)),
    );
  };

  const handleNameChange = (index: number, value: string): void => {
    // Security enhancement: enforce input length limit at state level
    // to prevent DoS/memory exhaustion if HTML maxLength is bypassed
    const player = playerConfigs[index];
    if (!player) return;
    nameValidation.beginNameEdit(player);
    updatePlayer(index, { name: value.slice(0, 16) });
  };

  const handleNameFocus = (index: number): void => {
    const player = playerConfigs[index];
    if (player) nameValidation.focusName(player.id);
  };

  const handleNameBlur = (index: number): void => {
    nameValidation.validateNames(playerConfigs[index]?.id);
  };

  const handleMenuClickCapture = (
    event: ReactMouseEvent<HTMLDivElement>,
  ): void => {
    if (!(event.target instanceof Element) || !event.target.closest("button")) {
      return;
    }
    nameValidation.validateNames(nameValidation.pendingPlayerId());
  };

  const handleControllerChange = (
    index: number,
    controller: PlayerController,
  ): void => {
    if (controller === "human") {
      const nextConfigs = playerConfigs.map((cfg, i) =>
        i === index ? { ...cfg, isHuman: true, aiProfile: undefined } : cfg,
      );
      setPlayerConfigs(nextConfigs);
      const changedPlayer = nextConfigs[index];
      if (changedPlayer) {
        nameValidation.validateNames(changedPlayer.id, nextConfigs);
      }
      // After re-render, focus and select the name input so user can immediately edit
      setTimeout(() => {
        const input = nameInputRefs.current[index];
        if (input) {
          input.focus();
          input.select();
        }
      }, 0);
      return;
    }

    const nextConfigs = playerConfigs.map((cfg, i) =>
      i === index
        ? {
            ...cfg,
            name: getDefaultAiName(controller, playerConfigs, index).slice(0, 16),
            isHuman: false,
            aiProfile: controller,
          }
        : cfg,
    );
    setPlayerConfigs(nextConfigs);
    const changedPlayer = nextConfigs[index];
    if (changedPlayer) {
      nameValidation.validateNames(changedPlayer.id, nextConfigs);
    }
  };

  const handleColorSelect = (index: number, newColor: Color): void => {
    updatePlayer(index, { color: newColor });
  };

  // Validation légère avant start
  const hasEmptyName = playerConfigs.some(
    (cfg) => cfg.name.trim().length === 0,
  );
  const canStart =
    !hasEmptyName && nameValidation.visibleErrorIds.size === 0;

  // Crée les objets Player complets (le GameEngine / TankManager écrasera les positions via spawnTanks)
  const handleStartClick = (): void => {
    const namesAreUnique = nameValidation.validateNames(
      nameValidation.pendingPlayerId(),
    );
    if (hasEmptyName || !namesAreUnique) return;

    const players: Player[] = playerConfigs.map((cfg, i) => {
      const color = cfg.color;
      const id = `player-${i + 1}`;
      const tankId = `tank-${i + 1}`;
      const trimmedName = cfg.name.trim();

      return {
        id,
        name: trimmedName,
        isHuman: cfg.isHuman,
        aiProfile: cfg.isHuman ? undefined : (cfg.aiProfile ?? "v1-random"),
        tank: {
          id: tankId,
          position: { x: 80 + i * 160, y: 280 }, // placeholder (spawnTanks recalcule sur terrain)
          angle: i < Math.ceil(numPlayers / 2) ? -32 : 32,
          power: 50,
          health: 100,
          maxHealth: 100,
          shield: 40,
          maxShield: 40,
          isDead: false,
          color,
          currentWeapon: "MISSILE",
        },
        money: 250,
        inventory: { ...DEFAULT_INVENTORY },
      };
    });

    onStartGame(players);
  };

  return (
    <MainMenuView
      numPlayers={numPlayers}
      playerConfigs={playerConfigs}
      colorPool={TANK_COLOR_POOL}
      nameErrorIds={nameValidation.visibleErrorIds}
      emptyNameErrorIds={nameValidation.emptyNameErrorIds}
      nameConflictSourceIds={nameValidation.conflictSourceIds}
      canStart={canStart}
      onMenuClickCapture={handleMenuClickCapture}
      onNumPlayersChange={changeNumPlayers}
      onNameInputRef={(index, el) => {
        nameInputRefs.current[index] = el;
      }}
      onNameChange={handleNameChange}
      onNameFocus={handleNameFocus}
      onNameBlur={handleNameBlur}
      onColorSelect={handleColorSelect}
      onControllerChange={handleControllerChange}
      onStart={handleStartClick}
      onPlayOnline={onPlayOnline}
    />
  );
}

import { useReducer, useState } from "react";
import { useTranslation } from "react-i18next";
import "./App.css";
import { GameCanvas } from "./components/GameCanvas";
import { MainMenu } from "./components/MainMenu";
import { OnlineLobby } from "./components/OnlineLobby";
import { LanguageSwitcher } from "./components/LanguageSwitcher";
import type { Player } from "./types/player";
import { SEO } from './components/SEO';
import {
  clearOnlineSession,
  readOnlineSession,
} from "./utils/onlineSession";
import {
  appReducer,
  createInitialAppState,
  type OnlineMeta,
} from "./appReducer";
import { isHotseatOnlyBuild } from "./utils/deploymentMode";

interface OnlineParams {
  readonly room: string | null;
  readonly slot: number | null;
  readonly token: string | null;
}

interface AppScreenProps {
  readonly showMenu: boolean;
  readonly showOnlineLobby: boolean;
  readonly isOnlineJoin: boolean;
  readonly onlineMultiplayerEnabled: boolean;
  readonly onlineParams: OnlineParams;
  readonly players: Player[] | null;
  readonly onlineMeta: OnlineMeta | null;
  readonly resumeCanvas: ReturnType<typeof createInitialAppState>["resumeCanvas"];
  readonly onStartLocalGame: (players: Player[]) => void;
  readonly onStartOnlineGame: (
    players: Player[],
    meta: OnlineMeta & { gameMode: "online" },
  ) => void;
  readonly onHideOnlineLobby: () => void;
  readonly onReturnToMenu: () => void;
}

function readOnlineParams(enabled: boolean): OnlineParams {
  if (!enabled || typeof window === "undefined") {
    return { room: null, slot: null, token: null };
  }

  const params = new URLSearchParams(window.location.search);
  const slotValue = params.get("slot");
  const parsedSlot = slotValue === null ? null : Number(slotValue);
  return {
    room: params.get("room"),
    slot: Number.isInteger(parsedSlot) ? parsedSlot : null,
    token: params.get("token"),
  };
}

function AppScreen({
  showMenu,
  showOnlineLobby,
  isOnlineJoin,
  onlineMultiplayerEnabled,
  onlineParams,
  players,
  onlineMeta,
  resumeCanvas,
  onStartLocalGame,
  onStartOnlineGame,
  onHideOnlineLobby,
  onReturnToMenu,
}: AppScreenProps) {
  if (!showMenu) {
    return (
      <div style={{ display: "flex", justifyContent: "center" }}>
        <GameCanvas
          initialPlayers={players ?? undefined}
          onReturnToMenu={onReturnToMenu}
          gameMode={onlineMeta ? "online" : "local"}
          localPlayerId={onlineMeta?.localPlayerId}
          roomId={onlineMeta?.roomId}
          initialHeights={onlineMeta?.initialHeights}
          initialMaterials={onlineMeta?.initialMaterials}
          initialWind={onlineMeta?.initialWind}
          initialCurrentPlayerIndex={onlineMeta?.initialCurrentPlayerIndex}
          resumeCanvas={resumeCanvas ?? undefined}
          slot={onlineMeta?.slot}
          token={onlineMeta?.token}
          ws={onlineMeta?.ws}
        />
      </div>
    );
  }

  if (showOnlineLobby) {
    return (
      <OnlineLobby
        initialRoomId={isOnlineJoin ? onlineParams.room! : undefined}
        initialSlot={isOnlineJoin ? onlineParams.slot! : undefined}
        initialToken={isOnlineJoin ? onlineParams.token! : undefined}
        onStartGame={onStartOnlineGame}
        onExitToLocalMenu={onHideOnlineLobby}
      />
    );
  }

  return (
    <MainMenu
      onStartGame={onStartLocalGame}
      {...(onlineMultiplayerEnabled
        ? { onPlayOnline: onHideOnlineLobby }
        : {})}
    />
  );
}

/**
 * Bestter's TankWars - Root App (src/App.tsx)
 *
 * Gère le gamePhase haut niveau (React-owned) :
 * - 'MENU' → affiche MainMenu (pas de Canvas → économies ressources)
 * - 'COMBAT' / autres → monte GameCanvas (qui gère son propre sous-état de phases internes + overlays)
 *
 * Au démarrage depuis le menu : les Player[] sont créés + passés à GameCanvas
 * qui les injecte dans l'engine (TerrainManager.generate + TankManager.spawnTanks faits à l'intérieur).
 */

function App() {
  const { t } = useTranslation();
  const hotseatOnly = isHotseatOnlyBuild();
  const onlineMultiplayerEnabled = !hotseatOnly;
  const [savedSession] = useState(() => {
    if (onlineMultiplayerEnabled) return readOnlineSession();
    clearOnlineSession();
    return null;
  });
  const [state, dispatch] = useReducer(
    appReducer,
    savedSession,
    createInitialAppState,
  );

  // Parse URL once on mount (supports direct join links and after create)
  const [onlineParams] = useState(() =>
    readOnlineParams(onlineMultiplayerEnabled),
  );

  const isOnlineJoin = !!onlineParams.room && onlineParams.slot !== null && !!onlineParams.token;
  const showOnlineLobby =
    onlineMultiplayerEnabled &&
    !state.onlineMatchStarted &&
    (isOnlineJoin || state.forceShowOnlineLobby);

  const handleStartGame = (initialPlayers: Player[]): void => {
    dispatch({ type: "START_LOCAL_GAME", players: initialPlayers });
  };

  const handleStartOnlineGame = (
    initialPlayers: Player[],
    meta: OnlineMeta & { gameMode: 'online' },
  ): void => {
    const onlineMeta: OnlineMeta = {
      roomId: meta.roomId,
      localPlayerId: meta.localPlayerId,
      initialHeights: meta.initialHeights,
      initialMaterials: meta.initialMaterials,
      initialWind: meta.initialWind,
      initialCurrentPlayerIndex: meta.initialCurrentPlayerIndex,
      slot: meta.slot,
      token: meta.token,
      ws: meta.ws,
    };
    dispatch({ type: "START_ONLINE_GAME", players: initialPlayers, meta: onlineMeta });
  };

  const handleReturnToMenu = (): void => {
    // Démontage du canvas/engine → libération ressources + retour config
    const hadOnline = !!state.onlineMeta || !!onlineParams.room;
    dispatch({ type: "RETURN_TO_MENU" });
    clearOnlineSession();
    // Best effort: clean URL params if we were in an online flow
    if (typeof window !== 'undefined' && hadOnline) {
      window.history.replaceState({}, '', window.location.pathname);
    }
  };

  const handleReturnToLobbyOrMenu = (): void => {
    if (state.onlineMeta) {
      const ok = window.confirm(t("online_quit_confirm"));
      if (!ok) return;
    }
    handleReturnToMenu();
  };

  const showMenu = state.phase === "MENU" && state.players === null;
  const { players, onlineMeta, resumeCanvas } = state;

  const handleOnlineMenuToggle = (): void => {
    if (showOnlineLobby) {
      dispatch({ type: "HIDE_ONLINE_LOBBY" });
      handleReturnToMenu();
      return;
    }
    dispatch({ type: "SHOW_ONLINE_LOBBY" });
  };

  return (
    <div
      style={{
        minHeight: "100vh",
        background: "#000000",
        fontFamily: "monospace",
        // Padding seulement hors menu (le menu gère son propre centrage full black)
        padding: showMenu ? 0 : "12px",
        position: "relative",
      }}
    >
      <SEO titleKey="seo_title" descriptionKey="seo_description" />
      {/* Sélecteur de langue disponible partout */}
      <div style={{ position: "absolute", top: 12, right: 12, zIndex: 100 }}>
        <LanguageSwitcher />
      </div>

      <AppScreen
        showMenu={showMenu}
        showOnlineLobby={showOnlineLobby}
        isOnlineJoin={isOnlineJoin}
        onlineMultiplayerEnabled={onlineMultiplayerEnabled}
        onlineParams={onlineParams}
        players={players}
        onlineMeta={onlineMeta}
        resumeCanvas={resumeCanvas}
        onStartLocalGame={handleStartGame}
        onStartOnlineGame={handleStartOnlineGame}
        onHideOnlineLobby={handleOnlineMenuToggle}
        onReturnToMenu={handleReturnToLobbyOrMenu}
      />
    </div>
  );
}

export default App;

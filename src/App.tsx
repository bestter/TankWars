import { captureOnlineEntry, cleanParticipationUrl, clearParticipation, readOnlineEntry, type OnlineParticipation, type OnlineEntryMessage } from './utils/onlineParticipation';
import { lazy, Suspense, useEffect, useReducer, useRef, useState } from "react";
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
} from "./utils/onlineSession";
import {
  appReducer,
  createInitialAppState,
  type OnlineMeta,
} from "./appReducer";
import { isHotseatOnlyBuild } from "./utils/deploymentMode";
// Vite replaces MODE at build time: outside endurance, the false branch removes
// this dynamic import and its dedicated modules. Keep the import inside the gate.
const EnduranceScreen = import.meta.env.MODE === "endurance"
  ? lazy(() => import("./components/endurance/EnduranceScreen").then(module => ({ default: module.EnduranceScreen })))
  : null;

interface AppScreenProps {
  readonly onEndurance?: () => void;
  readonly showMenu: boolean;
  readonly showOnlineLobby: boolean;
  readonly isOnlineJoin: boolean;
  readonly onlineMultiplayerEnabled: boolean;
  readonly participation: OnlineParticipation | null;
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

function AppScreen({
  showMenu,
  showOnlineLobby,
  isOnlineJoin,
  onlineMultiplayerEnabled,
  participation,
  players,
  onlineMeta,
  resumeCanvas,
  onStartLocalGame,
  onStartOnlineGame,
  onHideOnlineLobby,
  onReturnToMenu,
  onEndurance,
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
          initialMap={onlineMeta?.initialMap}
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
        initialRoomId={isOnlineJoin ? participation!.room : undefined}
        initialSlot={isOnlineJoin ? participation!.slot : undefined}
        initialToken={isOnlineJoin ? participation!.token : undefined}
        initialParticipation={participation ?? undefined}
        onStartGame={onStartOnlineGame}
        onExitToLocalMenu={onHideOnlineLobby}
      />
    );
  }

  return (
    <MainMenu
      onEndurance={onEndurance}
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
  const [showEndurance, setShowEndurance] = useState(false);
  const { t } = useTranslation();
  const hotseatOnly = isHotseatOnlyBuild();
  const onlineMultiplayerEnabled = !hotseatOnly;
  const [entry] = useState(() => readOnlineEntry(onlineMultiplayerEnabled));
  const [participation, setParticipation] = useState(entry.participation);
  const [messages, setMessages] = useReducer((_previous: OnlineEntryMessage[], next: OnlineEntryMessage[]) => next, []);
  const captured = useRef(false);
  useEffect(() => {
    const warn = (event: Event) => {
      if (!(event instanceof CustomEvent)) return;
      const key: unknown = event.detail;
      if (key === 'online_storage_clear_failed' || key === 'online_restore_unavailable') setMessages([key]);
    };
    window.addEventListener('online-persistence-warning', warn);
    return () => window.removeEventListener('online-persistence-warning', warn);
  }, []);
  useEffect(() => {
    if (captured.current) return;
    captured.current = true;
    setMessages(captureOnlineEntry(entry, onlineMultiplayerEnabled));
  }, [entry, onlineMultiplayerEnabled]);
  const [state, dispatch] = useReducer(appReducer, entry.session, createInitialAppState);
  const isOnlineJoin = participation !== null;
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
      initialMap: meta.initialMap,
      initialCurrentPlayerIndex: meta.initialCurrentPlayerIndex,
      slot: meta.slot,
      token: meta.token,
      ws: meta.ws,
    };
    dispatch({ type: "START_ONLINE_GAME", players: initialPlayers, meta: onlineMeta });
  };

  const handleReturnToMenu = (): void => {
    dispatch({ type: "RETURN_TO_MENU" });
    setParticipation(null);
    const clearedCombat = clearOnlineSession();
    const clearedLobby = clearParticipation();
    const cleaned = cleanParticipationUrl();
    setMessages([
      ...(!clearedCombat || !clearedLobby ? ['online_storage_clear_failed' as const] : []),
      ...(!cleaned ? ['online_url_cleanup_failed' as const] : []),
    ]);
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

      {messages.map(message => <p role="alert" key={message}>{t(message)}</p>)}
      {showEndurance && EnduranceScreen ? <Suspense fallback={<p>{t("endurance_loading")}</p>}><EnduranceScreen onExit={() => setShowEndurance(false)} /></Suspense> : <AppScreen
        onEndurance={EnduranceScreen ? () => setShowEndurance(true) : undefined}
        showMenu={showMenu}
        showOnlineLobby={showOnlineLobby}
        isOnlineJoin={isOnlineJoin}
        onlineMultiplayerEnabled={onlineMultiplayerEnabled}
        participation={participation}
        players={players}
        onlineMeta={onlineMeta}
        resumeCanvas={resumeCanvas}
        onStartLocalGame={handleStartGame}
        onStartOnlineGame={handleStartOnlineGame}
        onHideOnlineLobby={handleOnlineMenuToggle}
        onReturnToMenu={handleReturnToLobbyOrMenu}
      />}
    </div>
  );
}

export default App;

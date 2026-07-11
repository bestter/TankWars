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
  const [savedSession] = useState(() => readOnlineSession());
  const [state, dispatch] = useReducer(
    appReducer,
    savedSession,
    createInitialAppState,
  );

  // Parse URL once on mount (supports direct join links and after create)
  const [onlineParams] = useState(() => {
    if (typeof window === 'undefined') return { room: null as string | null, slot: null as number | null, token: null as string | null };
    const p = new URLSearchParams(window.location.search);
    const room = p.get('room');
    const slotStr = p.get('slot');
    const token = p.get('token');
    const slot = slotStr !== null ? Number(slotStr) : null;
    return { room, slot: Number.isFinite(slot) ? slot! : null, token };
  });

  const isOnlineJoin = !!onlineParams.room && onlineParams.slot !== null && !!onlineParams.token;
  const showOnlineLobby =
    !state.onlineMatchStarted && (isOnlineJoin || state.forceShowOnlineLobby);

  const handleStartGame = (initialPlayers: Player[]): void => {
    dispatch({ type: "START_LOCAL_GAME", players: initialPlayers });
  };

  const handleStartOnlineGame = (
    initialPlayers: Player[],
    meta: { roomId: string; localPlayerId: string; gameMode: 'online'; initialHeights?: number[]; initialWind?: number; initialCurrentPlayerIndex?: number; slot?: number; token?: string; ws?: WebSocket },
  ): void => {
    const onlineMeta: OnlineMeta = {
      roomId: meta.roomId,
      localPlayerId: meta.localPlayerId,
      initialHeights: meta.initialHeights,
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

      {showMenu ? (
        showOnlineLobby ? (
          <OnlineLobby
            initialRoomId={isOnlineJoin ? onlineParams.room! : undefined}
            initialSlot={isOnlineJoin ? onlineParams.slot! : undefined}
            initialToken={isOnlineJoin ? onlineParams.token! : undefined}
            onStartGame={handleStartOnlineGame}
            onExitToLocalMenu={() => {
              dispatch({ type: "HIDE_ONLINE_LOBBY" });
              handleReturnToMenu();
            }}
          />
        ) : (
          <MainMenu
            onStartGame={handleStartGame}
            onPlayOnline={() => dispatch({ type: "SHOW_ONLINE_LOBBY" })}
          />
        )
      ) : (
        <div style={{ display: "flex", justifyContent: "center" }}>
          <GameCanvas
            initialPlayers={players ?? undefined}
            onReturnToMenu={handleReturnToLobbyOrMenu}
            gameMode={onlineMeta ? 'online' : 'local'}
            localPlayerId={onlineMeta?.localPlayerId}
            roomId={onlineMeta?.roomId}
            initialHeights={onlineMeta?.initialHeights}
            initialWind={onlineMeta?.initialWind}
            initialCurrentPlayerIndex={onlineMeta?.initialCurrentPlayerIndex}
            resumeCanvas={resumeCanvas ?? undefined}
            slot={onlineMeta?.slot}
            token={onlineMeta?.token}
            ws={onlineMeta?.ws}
          />
        </div>
      )}
    </div>
  );
}

export default App;

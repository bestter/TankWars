import { useState } from "react";
import { useTranslation } from "react-i18next";
import "./App.css";
import { GameCanvas } from "./components/GameCanvas";
import { MainMenu } from "./components/MainMenu";
import { OnlineLobby } from "./components/OnlineLobby";
import { LanguageSwitcher } from "./components/LanguageSwitcher";
import type { GamePhase } from "./types/game";
import type { Player } from "./types/player";
import { SEO } from './components/SEO';
import {
  clearOnlineSession,
  readOnlineSession,
  type OnlineCanvasSnapshot,
} from "./utils/onlineSession";

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

  const [phase, setPhase] = useState<GamePhase>(() =>
    savedSession ? "COMBAT" : "MENU",
  );
  const [players, setPlayers] = useState<Player[] | null>(
    () => savedSession?.players ?? null,
  );

  // Online lobby meta (when we came from a room link or host creation)
  const [onlineMeta, setOnlineMeta] = useState<{
    roomId: string;
    localPlayerId: string;
    initialHeights?: number[];
    initialWind?: number;
    initialCurrentPlayerIndex?: number;
    slot?: number;
    token?: string;
    ws?: WebSocket;
  } | null>(() => savedSession?.meta ?? null);

  // Local flag to force showing the OnlineLobby create UI from the "Play online" button in MainMenu
  const [forceShowOnlineLobby, setForceShowOnlineLobby] = useState(false);
  /** Once an online match has started, never route back to the waiting-room lobby on MENU. */
  const [onlineMatchStarted, setOnlineMatchStarted] = useState(
    () => !!savedSession,
  );
  const [resumeCanvas, setResumeCanvas] = useState<OnlineCanvasSnapshot | null>(
    () => savedSession?.canvas ?? null,
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
    !onlineMatchStarted && (isOnlineJoin || forceShowOnlineLobby);

  const handleStartGame = (initialPlayers: Player[]): void => {
    setPlayers(initialPlayers);
    setPhase("COMBAT");
  };

  const handleStartOnlineGame = (
    initialPlayers: Player[],
    meta: { roomId: string; localPlayerId: string; gameMode: 'online'; initialHeights?: number[]; initialWind?: number; initialCurrentPlayerIndex?: number; slot?: number; token?: string; ws?: WebSocket },
  ): void => {
    setPlayers(initialPlayers);
    setOnlineMeta({
      roomId: meta.roomId,
      localPlayerId: meta.localPlayerId,
      initialHeights: meta.initialHeights,
      initialWind: meta.initialWind,
      initialCurrentPlayerIndex: meta.initialCurrentPlayerIndex,
      slot: meta.slot,
      token: meta.token,
      ws: meta.ws,
    });
    setResumeCanvas(null);
    setOnlineMatchStarted(true);
    setForceShowOnlineLobby(false);
    setPhase("COMBAT");
  };

  const handleReturnToMenu = (): void => {
    // Démontage du canvas/engine → libération ressources + retour config
    setPlayers(null);
    setOnlineMeta(null);
    setResumeCanvas(null);
    setOnlineMatchStarted(false);
    setForceShowOnlineLobby(false);
    clearOnlineSession();
    // Best effort: clean URL params if we were in an online flow
    if (typeof window !== 'undefined' && (onlineParams.room || onlineMeta)) {
      window.history.replaceState({}, '', window.location.pathname);
    }
    setPhase("MENU");
  };

  const handleReturnToLobbyOrMenu = (): void => {
    if (onlineMeta) {
      const ok = window.confirm(t("online_quit_confirm"));
      if (!ok) return;
    }
    handleReturnToMenu();
  };

  const showMenu = phase === "MENU" && players === null;

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
              setForceShowOnlineLobby(false);
              handleReturnToMenu();
            }}
          />
        ) : (
          <MainMenu onStartGame={handleStartGame} onPlayOnline={() => setForceShowOnlineLobby(true)} />
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

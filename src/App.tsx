import { captureOnlineEntry, cleanParticipationUrl, clearParticipation, readOnlineEntry, type OnlineParticipation, type OnlineEntryMessage } from './utils/onlineParticipation';
import { onlineEntryMessagesReducer } from './utils/onlineEntryMessages';
import { OnlinePersistenceAlerts } from './components/OnlinePersistenceAlerts';
import { Activity, lazy, Suspense, useEffect, useLayoutEffect, useReducer, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import "./App.css";
import { GameCanvas } from "./components/GameCanvas";
import { MainMenu, type MainMenuProps } from "./components/MainMenu";
import { OnlineLobby } from "./components/OnlineLobby";
import { LanguageSwitcher } from "./components/LanguageSwitcher";
import type { Player } from "./types/player";
import { SEO } from './components/SEO';
import { OnlineQuitConfirmDialog } from './components/RecoveryDialogs';
import {
  clearOnlineSession,
} from "./utils/onlineSession";
import {
  appReducer,
  createInitialAppState,
  type OnlineMeta,
} from "./appReducer";
import { isHotseatOnlyBuild } from "./utils/deploymentMode";
import { ContactScreen } from "./contact/ContactScreen";
import { useContactRoute } from "./contact/useContactRoute";
// Vite replaces MODE at build time: outside endurance, the false branch removes
// this dynamic import and its dedicated modules. Keep the import inside the gate.
const EnduranceScreen = import.meta.env.MODE === "endurance"
  ? lazy(() => import("./components/endurance/EnduranceScreen").then(module => ({ default: module.EnduranceScreen })))
  : null;

interface AppScreenProps {
  readonly onEndurance?: () => void;
  readonly onContact?: () => void;
  readonly showContact: boolean;
  readonly onCloseContact: () => void;
  readonly showMenu: boolean;
  readonly showOnlineLobby: boolean;
  readonly isOnlineJoin: boolean;
  readonly onlineMultiplayerEnabled: boolean;
  readonly participation: OnlineParticipation | null;
  readonly players: Player[] | null;
  readonly onlineMeta: OnlineMeta | null;
  readonly resumeCanvas: ReturnType<typeof createInitialAppState>["resumeCanvas"];
  readonly freeWeapons: boolean;
  readonly quitConfirmationOpen: boolean;
  readonly onStartLocalGame: (players: Player[], options?: { freeWeapons?: boolean }) => void;
  readonly onStartOnlineGame: (
    players: Player[],
    meta: OnlineMeta & { gameMode: "online" },
  ) => void;
  readonly onHideOnlineLobby: () => void;
  readonly onReturnToMenu: () => void;
  readonly onPersistenceWarning: (message: OnlineEntryMessage) => void;
}

function LocalMenuScreen({
  showContact,
  onCloseContact,
  ...menuProps
}: MainMenuProps & Pick<AppScreenProps, 'showContact' | 'onCloseContact'>) {
  return (
    <>
      <Activity mode={showContact ? "hidden" : "visible"}>
        <MainMenu {...menuProps} />
      </Activity>
      {showContact && <ContactScreen onBack={onCloseContact} />}
    </>
  );
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
  freeWeapons,
  quitConfirmationOpen,
  onStartLocalGame,
  onStartOnlineGame,
  onHideOnlineLobby,
  onReturnToMenu,
  onPersistenceWarning,
  onEndurance,
  onContact,
  showContact,
  onCloseContact,
}: AppScreenProps) {
  if (!showMenu) {
    return (
      <div className="game-stage-shell">
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
          freeWeapons={freeWeapons}
          quitConfirmationOpen={quitConfirmationOpen}
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
        onPersistenceWarning={onPersistenceWarning}
        onStartGame={onStartOnlineGame}
        onExitToLocalMenu={onHideOnlineLobby}
      />
    );
  }

  return (
    <LocalMenuScreen
      showContact={showContact}
      onCloseContact={onCloseContact}
      onEndurance={onEndurance}
      onContact={onContact}
      onStartGame={onStartLocalGame}
      onPlayOnline={onlineMultiplayerEnabled ? onHideOnlineLobby : undefined}
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

function resolveActiveScreen(
  showEndurance: boolean,
  hasEnduranceScreen: boolean,
  showMenu: boolean,
  showOnlineLobby: boolean,
): "endurance" | "combat" | "online-lobby" | "menu" {
  if (showEndurance && hasEnduranceScreen) return "endurance";
  if (!showMenu) return "combat";
  if (showOnlineLobby) return "online-lobby";
  return "menu";
}

function useScreenScroll(activeScreen: ReturnType<typeof resolveActiveScreen> | 'contact', mainRef: React.RefObject<HTMLElement | null>) {
  const previousScreen = useRef(activeScreen);
  useLayoutEffect(() => {
    if (previousScreen.current === activeScreen) return;
    if (previousScreen.current === 'contact' && activeScreen === 'menu') {
      mainRef.current?.focus({ preventScroll: true });
    }
    previousScreen.current = activeScreen;
    window.scrollTo(0, 0);
  }, [activeScreen, mainRef]);
}

function collectReturnToMenuMessages(): OnlineEntryMessage[] {
  const clearedCombat = clearOnlineSession();
  const clearedLobby = clearParticipation();
  const cleaned = cleanParticipationUrl();
  const nextMessages: OnlineEntryMessage[] = [];
  if (!clearedCombat || !clearedLobby) {
    nextMessages.push('online_storage_clear_failed');
  }
  if (!cleaned) {
    nextMessages.push('online_url_cleanup_failed');
  }
  return nextMessages;
}

function App() {
  const [showEndurance, setShowEndurance] = useState(false);
  const [onlineQuitConfirmRequestId, setOnlineQuitConfirmRequestId] = useState<number | null>(null);
  const nextOnlineQuitConfirmRequestIdRef = useRef(0);
  const mainRef = useRef<HTMLElement>(null);
  const { t } = useTranslation();
  const hotseatOnly = isHotseatOnlyBuild();
  const onlineMultiplayerEnabled = !hotseatOnly;
  const [entry] = useState(() => readOnlineEntry(onlineMultiplayerEnabled));
  const [participation, setParticipation] = useState(entry.participation);
  const [messages, setMessages] = useReducer(onlineEntryMessagesReducer, []);
  const handlePersistenceWarning = (message: OnlineEntryMessage) => {
    setMessages({ type: 'add', messages: [message] });
  };
  const captured = useRef(false);
  useEffect(() => {
    const warn = (event: Event) => {
      if (!(event instanceof CustomEvent)) return;
      const key: unknown = event.detail;
      if (key === 'online_storage_clear_failed' || key === 'online_restore_unavailable') {
        setMessages({ type: 'add', messages: [key] });
      }
    };
    window.addEventListener('online-persistence-warning', warn);
    return () => window.removeEventListener('online-persistence-warning', warn);
  }, []);
  useEffect(() => {
    if (captured.current) return;
    captured.current = true;
    setMessages({ type: 'replace', messages: captureOnlineEntry(entry, onlineMultiplayerEnabled) });
  }, [entry, onlineMultiplayerEnabled]);
  const [state, dispatch] = useReducer(appReducer, entry.session, createInitialAppState);
  const isOnlineJoin = participation !== null;
  const showOnlineLobby =
    onlineMultiplayerEnabled &&
    !state.onlineMatchStarted &&
    (isOnlineJoin || state.forceShowOnlineLobby);

  const handleStartGame = (initialPlayers: Player[], options?: { freeWeapons?: boolean }): void => {
    dispatch({ type: "START_LOCAL_GAME", players: initialPlayers, freeWeapons: options?.freeWeapons ?? false });
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
    setOnlineQuitConfirmRequestId(null);
    dispatch({ type: "RETURN_TO_MENU" });
    setParticipation(null);
    setMessages({ type: 'replace', messages: collectReturnToMenuMessages() });
  };

  const handleReturnToLobbyOrMenu = (): void => {
    if (state.onlineMeta) {
      nextOnlineQuitConfirmRequestIdRef.current += 1;
      setOnlineQuitConfirmRequestId(nextOnlineQuitConfirmRequestIdRef.current);
      return;
    }
    handleReturnToMenu();
  };

  const showMenu = state.phase === "MENU" && state.players === null;
  const { players, onlineMeta, resumeCanvas } = state;
  const quitConfirmationOpen =
    onlineQuitConfirmRequestId !== null && Boolean(onlineMeta);

  const gameScreen = resolveActiveScreen(
    showEndurance,
    Boolean(EnduranceScreen),
    showMenu,
    showOnlineLobby,
  );
  const { showContact, openContact, closeContact, navigationFailed } = useContactRoute(gameScreen === 'menu', hotseatOnly);
  useScreenScroll(showContact ? 'contact' : gameScreen, mainRef);

  const handleOnlineMenuToggle = (): void => {
    if (showOnlineLobby) {
      dispatch({ type: "HIDE_ONLINE_LOBBY" });
      handleReturnToMenu();
      return;
    }
    dispatch({ type: "SHOW_ONLINE_LOBBY" });
  };

  return (
    <div className={`app-shell${showMenu ? " app-shell--menu" : ""}`}>
      {!showContact && <SEO titleKey="seo_title" descriptionKey="seo_description" />}
      <header className="app-header">
        <a
          href="#main-content"
          className="skip-link visually-hidden"
          onClick={() => {
            mainRef.current?.focus();
          }}
        >
          {t("skip_to_content")}
        </a>
        {/* Sélecteur de langue disponible partout */}
        <div className="app-header-lang">
          <LanguageSwitcher />
        </div>
      </header>

      <main ref={mainRef} id="main-content" tabIndex={-1} className="app-main">
        <OnlinePersistenceAlerts messages={messages} />
        {navigationFailed && gameScreen === 'menu' && (
          <p className="contact-error" role="alert">{t('contact_navigation_error')}</p>
        )}
        {showEndurance && EnduranceScreen ? (
          <Suspense fallback={<p>{t("endurance_loading")}</p>}>
            <EnduranceScreen onExit={() => setShowEndurance(false)} />
          </Suspense>
        ) : (
          <AppScreen
            onEndurance={EnduranceScreen ? () => setShowEndurance(true) : undefined}
            onContact={openContact}
            showContact={showContact}
            onCloseContact={closeContact}
            showMenu={showMenu}
            showOnlineLobby={showOnlineLobby}
            isOnlineJoin={isOnlineJoin}
            onlineMultiplayerEnabled={onlineMultiplayerEnabled}
            participation={participation}
            players={players}
            onlineMeta={onlineMeta}
            resumeCanvas={resumeCanvas}
            freeWeapons={state.freeWeapons}
            quitConfirmationOpen={quitConfirmationOpen}
            onStartLocalGame={handleStartGame}
            onStartOnlineGame={handleStartOnlineGame}
            onHideOnlineLobby={handleOnlineMenuToggle}
            onReturnToMenu={handleReturnToLobbyOrMenu}
            onPersistenceWarning={handlePersistenceWarning}
          />
        )}
        {quitConfirmationOpen && (
          <OnlineQuitConfirmDialog
            key={onlineQuitConfirmRequestId}
            onCancel={() => setOnlineQuitConfirmRequestId(null)}
            onConfirm={handleReturnToMenu}
          />
        )}
      </main>
    </div>
  );
}

export default App;

/**
 * TankWars Online Lobby (src/components/OnlineLobby.tsx)
 *
 * Handles:
 * - Host creation flow (select N + per-slot Human/IA, call backend, show all shareable URLs)
 * - Join flow (from ?room=...&slot=...&token=..., enter name, connect)
 * - Live waiting room with roster updates via WebSocket
 * - Auto-start when all human slots are filled (per user spec)
 *
 * Uses native WebSocket (no extra deps). Fully retro VGA styling.
 * All user-facing strings come from i18n (t()).
 *
 * MVP scope: 1-round deathmatch only. Full multi-round + shop in later iteration.
 */

import { useTranslation } from 'react-i18next';
import { VGA_PALETTE } from '../types/game';
import type { OnlineLobbyProps } from './onlineLobbyTypes';
import { OnlineLobbyCreate } from './OnlineLobbyCreate';
import { OnlineLobbyWaiting } from './OnlineLobbyWaiting';
import { useOnlineLobby } from './useOnlineLobby';

export type { OnlineLobbyProps } from './onlineLobbyTypes';

export function OnlineLobby(props: OnlineLobbyProps) {
  const { t } = useTranslation();
  const lobby = useOnlineLobby(props);
  const { view, error, isJoinMode } = lobby;

  return (
    <div className="retro-menu-container" style={{ padding: 12 }}>
      <div className="retro-menu-frame" style={{ maxWidth: 820, margin: '0 auto' }}>
        <div className="retro-menu-inner">
          <h1 className="retro-title" style={{ fontSize: 28 }}>{t('main_title')}</h1>
          <p className="retro-subtitle" style={{ marginBottom: 12 }}>{t('create_online_game')}</p>

          {error && (
            <div style={{ color: VGA_PALETTE.RED, marginBottom: 10, fontSize: 13 }}>{error}</div>
          )}

          {view === 'create' && !isJoinMode && (
            <OnlineLobbyCreate
              numPlayers={lobby.numPlayers}
              slotConfigs={lobby.slotConfigs}
              canCreate={lobby.canCreate}
              isCreating={lobby.isCreating}
              onChangeNumPlayers={lobby.changeNumPlayers}
              onUpdateSlot={lobby.updateSlot}
              onCreateRoom={lobby.handleCreateRoom}
              onExitToLocalMenu={lobby.onExitToLocalMenu}
            />
          )}

          {(view === 'waiting' || view === 'joining') && (
            <OnlineLobbyWaiting
              view={view}
              roomId={lobby.roomId}
              numPlayers={lobby.numPlayers}
              myName={lobby.myName}
              setMyName={lobby.setMyName}
              slotsInfo={lobby.slotsInfo}
              roster={lobby.roster}
              isJoining={lobby.isJoining}
              copyFeedback={lobby.copyFeedback}
              serverGameLive={lobby.serverGameLive}
              connected={lobby.connected}
              initialSlot={props.initialSlot}
              onJoin={lobby.handleJoin}
              onCopyLink={lobby.copyLink}
              onLeaveRoom={lobby.leaveRoom}
            />
          )}

          <div className="retro-legal" style={{ marginTop: 16 }}>
            {t('legal_footer')}
          </div>
        </div>
      </div>
    </div>
  );
}

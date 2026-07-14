import { useTranslation } from 'react-i18next';
import { VGA_PALETTE } from '../types/game';
import type { JoinedInfo, LobbyView, SlotUI } from './onlineLobbyTypes';

export interface OnlineLobbyWaitingProps {
  view: LobbyView;
  roomId: string | null;
  numPlayers: 2 | 3 | 4;
  myName: string;
  setMyName: (name: string) => void;
  slotsInfo: SlotUI[];
  roster: JoinedInfo[];
  isJoining: boolean;
  copyFeedback: Record<number, boolean>;
  serverGameLive: boolean;
  connected: boolean;
  initialSlot?: number;
  onJoin: () => void;
  onCopyLink: (url: string | null, slot: number) => void;
  onLeaveRoom: () => void;
}

export function OnlineLobbyWaiting({
  view,
  roomId,
  numPlayers,
  myName,
  setMyName,
  slotsInfo,
  roster,
  isJoining,
  copyFeedback,
  serverGameLive,
  connected,
  initialSlot,
  onJoin,
  onCopyLink,
  onLeaveRoom,
}: OnlineLobbyWaitingProps) {
  const { t } = useTranslation();

  return (
    <>
      <div style={{ color: VGA_PALETTE.CYAN, marginBottom: 8, fontSize: 13 }}>
        {roomId ? `${t('room_code_label')}: ${roomId}` : t('connecting')}
      </div>

      {view === 'joining' && (
        <div style={{ marginBottom: 12 }}>
          <div style={{ marginBottom: 6 }}>{t('you_are_player', { num: (initialSlot ?? 0) + 1, slot: initialSlot ?? 0 })}</div>
          <input
            type="text"
            placeholder={t('enter_name_placeholder')}
            aria-label={t('enter_name_placeholder')}
            value={myName}
            maxLength={16}
            onChange={(e) => setMyName(e.target.value.slice(0, 16))}
            style={{ width: '100%', padding: 6, background: '#000', color: '#fff', border: '1px solid #555' }}
          />
          <button
            type="button"
            className="retro-start-btn"
            style={{ marginTop: 8, width: '100%' }}
            onClick={onJoin}
            disabled={!myName.trim() || isJoining}
          >
            {isJoining ? t('joining') : t('join_room_btn')}
          </button>
        </div>
      )}

      {/* After creation or successful join: show links (host) + roster */}
      {view === 'waiting' && slotsInfo.length > 0 && (
        <div style={{ marginBottom: 10 }}>
          <div style={{ color: '#AAAAAA', fontSize: 12, marginBottom: 4 }}>{t('room_created')}</div>
          {slotsInfo.map((s) => (
            <div key={s.slot} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4, fontSize: 12 }}>
              <span style={{ color: s.type === 'human' ? VGA_PALETTE.FLASH_GREEN : '#888', width: 140 }}>
                {t('slot_label', { num: s.slot + 1 })} — {s.type === 'human' ? 'HUMAIN' : `IA ${s.aiProfile || ''}`}
              </span>
              {s.url && (
                <>
                  <button type="button" onClick={() => onCopyLink(s.url, s.slot)} style={{ fontSize: 12 }}>
                    {copyFeedback[s.slot] ? t('link_copied') : t('copy_link')}
                  </button>
                  <a href={s.url} target="_blank" rel="noreferrer" style={{ fontSize: 12, color: VGA_PALETTE.ELECTRIC_CYAN }}>
                    {t('open_link')}
                  </a>
                </>
              )}
              {!s.url && <span style={{ color: '#666' }}>(IA — pas de lien)</span>}
            </div>
          ))}
        </div>
      )}

      {/* Live roster */}
      <div style={{ marginBottom: 8, color: VGA_PALETTE.YELLOW, fontSize: 13 }}>
        {t('waiting_room_title')} — {t('players_connected', { joined: roster.length, total: numPlayers || slotsInfo.length || 2 })}
      </div>

      <div style={{ fontSize: 12, marginBottom: 10, lineHeight: 1.5 }}>
        {roster.length === 0 && <span>{t('waiting_for_players')}</span>}
        {roster.map((r) => (
          <div key={r.slot} style={{ color: r.type === 'ai' ? '#888' : '#fff' }}>
            {t('slot_label', { num: r.slot + 1 })} : {r.name} {r.type === 'ai' ? `(${t('slot_status_ai')})` : ''}
          </div>
        ))}
      </div>

      <div style={{ color: '#666', fontSize: 12, marginBottom: 12 }}>{t('auto_start_note')}</div>

      {serverGameLive && (
        <div style={{ color: VGA_PALETTE.FLASH_GREEN, fontSize: 12, marginBottom: 8 }}>
          {t('all_ready_auto_start')}
        </div>
      )}

      <div style={{ display: 'flex', gap: 8, justifyContent: 'center' }}>
        <button type="button" onClick={onLeaveRoom}>
          {t('leave_room')}
        </button>
      </div>

      {connected && <div style={{ marginTop: 8, fontSize: 12, color: VGA_PALETTE.FLASH_GREEN }}>● Connecté</div>}
    </>
  );
}

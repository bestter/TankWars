import { useCallback, useId, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { VGA_PALETTE } from '../types/game';
import type { CopySlotFeedback, JoinedInfo, LobbyView, SlotUI } from './onlineLobbyTypes';

const AI_SLOT_KEYS = {
  'v1-random': 'slot_ai_simple',
  'v2-heuristic': 'slot_ai_ok',
  'v3-sniper': 'slot_ai_sniper',
  'v4-smart': 'slot_ai_expert',
} as const;

export interface OnlineLobbyWaitingProps {
  view: LobbyView;
  roomId: string | null;
  numPlayers: 2 | 3 | 4;
  myName: string;
  setMyName: (name: string) => void;
  slotsInfo: SlotUI[];
  roster: JoinedInfo[];
  isJoining: boolean;
  copyFeedback: Record<number, CopySlotFeedback | undefined>;
  serverGameLive: boolean;
  connected: boolean;
  initialSlot?: number;
  onJoin: () => void;
  onCopyLink: (url: string | null, slot: number) => void;
  onDismissCopyFeedback: (slot: number) => void;
  onLeaveRoom: () => void;
}

function InviteActions({
  slot,
  slotLabel,
  url,
  feedback,
  onCopyLink,
  onDismissCopyFeedback,
}: Pick<OnlineLobbyWaitingProps, 'onCopyLink' | 'onDismissCopyFeedback'> & {
  slot: number;
  slotLabel: string;
  url: string;
  feedback: CopySlotFeedback | undefined;
}) {
  const { t } = useTranslation();
  const copyButtonRef = useRef<HTMLButtonElement>(null);
  const fallbackRef = useCallback((fallback: HTMLDivElement | null) => {
    if (!fallback) return;
    return () => {
      // Move focus before React removes the focused control from the DOM.
      if (fallback.contains(fallback.ownerDocument.activeElement)) {
        copyButtonRef.current?.focus();
      }
    };
  }, []);
  const message = feedback
    ? t(feedback.status === 'copied' ? 'link_copied' : 'link_copy_failed')
      + (feedback.appendAnnouncementSpace ? '\u00A0' : '')
    : '';

  return (
    <div className="lobby-wait-slot-actions">
      <button
        ref={copyButtonRef}
        type="button"
        className="lobby-action-btn"
        data-copied={feedback?.status === 'copied' ? '' : undefined}
        data-failed={feedback?.status === 'failed' ? '' : undefined}
        onClick={() => onCopyLink(url, slot)}
      >
        {t('copy_link')}{' '}
        <span className="visually-hidden">— {slotLabel}</span>
      </button>
      <span role="status" className="lobby-copy-status" data-status={feedback?.status}>
        {message}
      </span>
      <a href={url} target="_blank" rel="noopener noreferrer" className="lobby-action-link" style={{ color: VGA_PALETTE.ELECTRIC_CYAN }}>
        {t('open_link')}{' '}
        <span className="visually-hidden">— {slotLabel}</span>
      </a>
      {feedback?.status === 'failed' && (
        <div ref={fallbackRef} className="lobby-copy-fallback">
          <input
            type="text"
            readOnly
            value={url}
            aria-label={t('invite_url_label', { num: slot + 1 })}
            className="lobby-copy-fallback-url"
            onFocus={(e) => e.currentTarget.select()}
          />
          <button
            type="button"
            className="lobby-action-btn lobby-copy-fallback-close"
            onClick={() => {
              onDismissCopyFeedback(slot);
              copyButtonRef.current?.focus();
            }}
          >
            {t('copy_fallback_close')}{' '}
            <span className="visually-hidden">— {slotLabel}</span>
          </button>
        </div>
      )}
    </div>
  );
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
  onDismissCopyFeedback,
  onLeaveRoom,
}: OnlineLobbyWaitingProps) {
  const { t } = useTranslation();
  const joinNameId = useId();

  const formatSlotRole = (slot: SlotUI): string => {
    if (slot.type === 'human') {
      return slot.slot === 0 ? t('your_slot') : t('controller_human');
    }
    const profile = slot.aiProfile;
    if (profile && Object.hasOwn(AI_SLOT_KEYS, profile)) {
      return t(AI_SLOT_KEYS[profile as keyof typeof AI_SLOT_KEYS]);
    }
    return t('lobby_slot_ai', { profile: profile ?? '' }).trim();
  };

  return (
    <>
      <div className="lobby-room-code" style={{ color: VGA_PALETTE.CYAN, marginBottom: 8, fontSize: 13 }}>
        {roomId ? `${t('room_code_label')}: ${roomId}` : t('connecting')}
      </div>

      {view === 'joining' && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!myName.trim() || isJoining) return;
            onJoin();
          }}
          style={{ marginBottom: 12 }}
        >
          <div style={{ marginBottom: 6 }}>{t('you_are_player', { num: (initialSlot ?? 0) + 1, slot: initialSlot ?? 0 })}</div>
          <label htmlFor={joinNameId} className="lobby-name-label">
            {t('join_name_label')}
          </label>
          <input
            id={joinNameId}
            name="playerName"
            type="text"
            className="lobby-name-input"
            placeholder={t('enter_name_placeholder')}
            autoComplete="nickname"
            enterKeyHint="done"
            value={myName}
            maxLength={16}
            onChange={(e) => setMyName(e.target.value.slice(0, 16))}
          />
          <button
            type="submit"
            className="retro-start-btn"
            style={{ marginTop: 8, width: '100%' }}
            disabled={!myName.trim() || isJoining}
          >
            {isJoining ? t('joining') : t('join_room_btn')}
          </button>
        </form>
      )}

      {/* After creation or successful join: show links (host) + roster */}
      {view === 'waiting' && slotsInfo.length > 0 && (
        <div style={{ marginBottom: 10 }}>
          <h2 className="lobby-section-heading">{t('room_created')}</h2>
          <ul className="lobby-list" role="list">
            {slotsInfo.map((s) => {
              const slotLabel = t('slot_label', { num: s.slot + 1 });
              return (
                <li key={s.slot} className="lobby-wait-slot-row">
                  <span className="lobby-wait-slot-label" style={{ color: s.type === 'human' ? VGA_PALETTE.FLASH_GREEN : '#AAAAAA' }}>
                    {slotLabel} — {formatSlotRole(s)}
                  </span>
                  {s.url ? (
                    <InviteActions
                      slot={s.slot}
                      slotLabel={slotLabel}
                      url={s.url}
                      feedback={copyFeedback[s.slot]}
                      onCopyLink={onCopyLink}
                      onDismissCopyFeedback={onDismissCopyFeedback}
                    />
                  ) : <span style={{ color: '#AAAAAA' }}>{t('lobby_ai_no_link')}</span>}
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {/* Live roster */}
      <h2 className="lobby-section-heading lobby-waiting-heading">
        {t('waiting_room_title')} — {t('players_connected', { joined: roster.length, total: numPlayers || slotsInfo.length || 2 })}
      </h2>

      <div className="lobby-roster">
        {roster.length === 0 ? (
          <span>{t('waiting_for_players')}</span>
        ) : (
          <ul className="lobby-list" role="list">
            {roster.map((r) => (
              <li key={r.slot} style={{ color: r.type === 'ai' ? '#AAAAAA' : '#fff' }}>
                {t('slot_label', { num: r.slot + 1 })} : {r.name} {r.type === 'ai' ? `(${t('slot_status_ai')})` : ''}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div style={{ color: '#AAAAAA', fontSize: 12, marginBottom: 12 }}>{t('auto_start_note')}</div>

      {serverGameLive && (
        <div style={{ color: VGA_PALETTE.FLASH_GREEN, fontSize: 12, marginBottom: 8 }}>
          {t('all_ready_auto_start')}
        </div>
      )}

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, justifyContent: 'center' }}>
        <button type="button" className="lobby-action-btn" onClick={onLeaveRoom}>
          {t('leave_room')}
        </button>
      </div>

      {connected && (
        <div style={{ marginTop: 8, fontSize: 12, color: VGA_PALETTE.FLASH_GREEN }}>
          <span aria-hidden="true">● </span>
          {t('lobby_connected')}
        </div>
      )}
    </>
  );
}

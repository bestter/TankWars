import { useTranslation } from 'react-i18next';
import type { RoomSlotConfig } from '../types/room';
import { VGA_PALETTE } from '../types/game';

export interface OnlineLobbyCreateProps {
  numPlayers: 2 | 3 | 4;
  slotConfigs: RoomSlotConfig[];
  canCreate: boolean;
  isCreating: boolean;
  onChangeNumPlayers: (n: 2 | 3 | 4) => void;
  onUpdateSlot: (idx: number, patch: Partial<RoomSlotConfig>) => void;
  onCreateRoom: () => void;
  onExitToLocalMenu?: () => void;
}

export function OnlineLobbyCreate({
  numPlayers,
  slotConfigs,
  canCreate,
  isCreating,
  onChangeNumPlayers,
  onUpdateSlot,
  onCreateRoom,
  onExitToLocalMenu,
}: OnlineLobbyCreateProps) {
  const { t } = useTranslation();

  return (
    <>
      <div style={{ marginBottom: 10, color: '#AAAAAA', fontSize: 12 }}>{t('num_players_label')}</div>
      <div style={{ marginBottom: 14 }}>
        {[2, 3, 4].map((n) => (
          <button
            key={n}
            type="button"
            className={`retro-num-btn ${n === numPlayers ? 'active' : ''}`}
            onClick={() => onChangeNumPlayers(n as 2 | 3 | 4)}
          >
            {n}
          </button>
        ))}
      </div>

      <div style={{ marginBottom: 8, color: '#AAAAAA', fontSize: 12 }}>
        {t('battle_configuration')} — {t('auto_start_note')}
      </div>

      {import.meta.env.DEV && (
        <div style={{ fontSize: 12, color: '#666', marginBottom: 8 }}>
          Dev: Assurez-vous que <code>npm run worker:dev</code> tourne dans un autre terminal (port 8787 par défaut).
        </div>
      )}

      {slotConfigs.map((cfg, idx) => (
        <div key={cfg.id} style={{ marginBottom: 6, display: 'flex', gap: 8, alignItems: 'center' }}>
          <span style={{ width: 92, color: VGA_PALETTE.YELLOW, fontSize: 12 }}>
            {t('slot_label', { num: idx + 1 })}
          </span>

          <select
            aria-label={t('controller_type_aria_label', { num: idx + 1 })}
            value={cfg.type === 'human' ? 'human' : `ai:${cfg.aiProfile}`}
            onChange={(e) => {
              const v = e.target.value;
              if (v === 'human') {
                onUpdateSlot(idx, { type: 'human', aiProfile: undefined });
              } else {
                const prof = v.split(':')[1] as 'v1-random' | 'v2-heuristic' | 'v3-sniper' | 'v4-smart' | undefined;
                onUpdateSlot(idx, { type: 'ai', aiProfile: prof });
              }
            }}
            style={{ background: '#111', color: '#fff', border: '1px solid #555', padding: '2px 6px' }}
          >
            <option value="human">{t('slot_human')}</option>
            <option value="ai:v1-random">{t('slot_ai_simple')}</option>
            <option value="ai:v2-heuristic">{t('slot_ai_ok')}</option>
            <option value="ai:v3-sniper">{t('slot_ai_sniper')}</option>
            <option value="ai:v4-smart">{t('slot_ai_expert')}</option>
          </select>

          {cfg.type === 'human' && idx > 0 && (
            <span style={{ fontSize: 12, color: '#666' }}>
              {t('link_instructions')}
            </span>
          )}
        </div>
      ))}

      <div style={{ marginTop: 14, textAlign: 'center' }}>
        <button
          type="button"
          className="retro-start-btn"
          onClick={onCreateRoom}
          disabled={!canCreate || isCreating}
          style={{ opacity: canCreate && !isCreating ? 1 : 0.6 }}
        >
          {isCreating ? t('creating_room') : t('create_room_btn')}
        </button>
      </div>

      <div style={{ marginTop: 16, textAlign: 'center' }}>
        <button type="button" onClick={onExitToLocalMenu} style={{ fontSize: 12 }}>
          {t('online_back_to_local')}
        </button>
      </div>
    </>
  );
}

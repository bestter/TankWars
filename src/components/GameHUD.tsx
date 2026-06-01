/**
 * TankWars - GameHUD React Component (src/components/GameHUD.tsx)
 *
 * Retro VGA-style overlay HUD that sits on top of the game Canvas.
 * Displays live turn/player info from TurnManager via props (decoupled).
 *
 * - Thick borders, monospace, high-contrast VGA palette accents (Cyan/Magenta/Green/Yellow)
 * - Player name + color swatch
 * - Angle + Power
 * - Wind force + direction arrow
 * - Current weapon + remaining ammo
 * - Clickable weapon selector (small retro buttons) + keyboard support (A/E) handled upstream in TurnManager
 */

import type { CurrentTurnInfo } from '../game/engine/TurnManager';
import type { WeaponId } from '../types/weapon';
import { WEAPON_REGISTRY } from '../types/weapon';
import { VGA_PALETTE } from '../types/game';

export interface GameHUDProps {
  turnInfo: CurrentTurnInfo | null;
  wind: number;
  /** Called when human clicks a weapon button. Parent wires to TurnManager.selectWeapon */
  onWeaponSelect?: (weaponId: WeaponId) => void;
}

const WEAPON_ORDER: readonly WeaponId[] = ['MISSILE', 'GRENADE', 'CLUSTER', 'NUKE', 'DRILLER'] as const;

function getShortLabel(id: WeaponId): string {
  switch (id) {
    case 'MISSILE': return 'MIS';
    case 'GRENADE': return 'GRE';
    case 'CLUSTER': return 'CLS';
    case 'NUKE': return 'NUK';
    case 'DRILLER': return 'DRL';
  }
}

export function GameHUD({ turnInfo, wind, onWeaponSelect }: GameHUDProps) {
  const isHumanTurn = !!turnInfo?.isHuman;
  const isLocked = !!turnInfo?.isInputLocked;
  const canInteract = isHumanTurn && !isLocked;

  const currentWeapon = turnInfo?.currentWeapon;
  const inventory = turnInfo?.inventory ?? {};

  const windDir = wind >= 0 ? '→' : '←';
  const windAbs = Math.abs(wind);

  return (
    <div
      style={{
        position: 'absolute',
        top: 4,
        left: 4,
        right: 4,
        zIndex: 5,
        backgroundColor: 'rgba(0, 0, 0, 0.82)',
        border: `3px solid ${VGA_PALETTE.CYAN}`,
        fontFamily: 'monospace',
        fontSize: '10px',
        lineHeight: '1.1',
        color: VGA_PALETTE.WHITE,
        padding: '3px 8px',
        display: 'flex',
        alignItems: 'center',
        gap: '10px',
        pointerEvents: 'none', // most areas non-interactive
        boxShadow: '0 0 0 1px #000 inset',
      }}
    >
      {/* === PLAYER === */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, pointerEvents: 'none' }}>
        <span style={{ color: VGA_PALETTE.MAGENTA, fontWeight: 'bold' }}>P:</span>
        {turnInfo ? (
          <>
            <span
              style={{
                display: 'inline-block',
                width: 9,
                height: 9,
                backgroundColor: turnInfo.playerColor,
                border: `1px solid ${VGA_PALETTE.WHITE}`,
                marginRight: 2,
                verticalAlign: 'middle',
              }}
            />
            <span style={{ color: turnInfo.playerColor, fontWeight: 'bold' }}>
              {turnInfo.playerName}
            </span>
          </>
        ) : (
          <span style={{ color: VGA_PALETTE.GRAY }}>—</span>
        )}
      </div>

      {/* === ANGLE / POWER === */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, pointerEvents: 'none' }}>
        <span style={{ color: VGA_PALETTE.CYAN }}>ANG</span>
        <span style={{ color: VGA_PALETTE.YELLOW, fontWeight: 'bold', minWidth: 28 }}>
          {turnInfo ? `${turnInfo.angle}°` : '--'}
        </span>
        <span style={{ color: VGA_PALETTE.CYAN, marginLeft: 4 }}>POW</span>
        <span style={{ color: VGA_PALETTE.YELLOW, fontWeight: 'bold', minWidth: 20 }}>
          {turnInfo ? turnInfo.power : '--'}
        </span>
      </div>

      {/* === WIND (gameState.windForce) === */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 3, color: VGA_PALETTE.GREEN, pointerEvents: 'none' }}>
        <span style={{ color: VGA_PALETTE.CYAN }}>WIND</span>
        <span style={{ fontWeight: 'bold' }}>
          {windDir} {windAbs}
        </span>
      </div>

      {/* === ROUND === */}
      <div style={{ color: VGA_PALETTE.GRAY, pointerEvents: 'none' }}>
        RND <span style={{ color: VGA_PALETTE.WHITE }}>{turnInfo ? turnInfo.round : '-'}</span>
      </div>

      {/* === WEAPON + SELECTOR (clickable) === */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 3,
          marginLeft: 'auto',
          pointerEvents: 'auto',
        }}
      >
        <span style={{ color: VGA_PALETTE.MAGENTA, marginRight: 2 }}>WEP</span>

        {WEAPON_ORDER.map((wid) => {
          const def = WEAPON_REGISTRY[wid];
          const ammo = inventory[wid] ?? 0;
          const isCurrent = currentWeapon === wid;
          const hasAmmo = ammo > 0;
          const selectable = canInteract && hasAmmo;

          const bg = isCurrent ? '#002200' : hasAmmo ? '#111111' : '#0a0a0a';
          const borderCol = isCurrent
            ? VGA_PALETTE.GREEN
            : hasAmmo
              ? VGA_PALETTE.GRAY
              : VGA_PALETTE.DARK_GRAY;
          const textCol = isCurrent
            ? def.color
            : hasAmmo
              ? VGA_PALETTE.WHITE
              : VGA_PALETTE.DARK_GRAY;

          return (
            <button
              key={wid}
              type="button"
              disabled={!selectable}
              onClick={() => {
                if (selectable && onWeaponSelect) {
                  onWeaponSelect(wid);
                }
              }}
              style={{
                fontFamily: 'monospace',
                fontSize: '9px',
                padding: '1px 5px',
                border: `2px solid ${borderCol}`,
                backgroundColor: bg,
                color: textCol,
                cursor: selectable ? 'pointer' : 'default',
                minWidth: 42,
                textAlign: 'center',
                lineHeight: '1',
                opacity: hasAmmo ? 1 : 0.55,
                outline: 'none',
              }}
              title={def.name}
            >
              {getShortLabel(wid)}:{ammo}
            </button>
          );
        })}

        {/* Lock / status indicator */}
        {turnInfo && isLocked && (
          <span
            style={{
              marginLeft: 6,
              color: VGA_PALETTE.RED,
              fontSize: '9px',
              pointerEvents: 'none',
            }}
          >
            [RESOLVING]
          </span>
        )}
        {turnInfo && !isHumanTurn && !isLocked && (
          <span
            style={{
              marginLeft: 6,
              color: VGA_PALETTE.CYAN,
              fontSize: '9px',
              pointerEvents: 'none',
            }}
          >
            [AI TURN]
          </span>
        )}
      </div>

      {/* Current weapon name (small) */}
      {turnInfo && (
        <div style={{ color: VGA_PALETTE.GRAY, fontSize: '9px', pointerEvents: 'none', minWidth: 52 }}>
          {WEAPON_REGISTRY[currentWeapon!]?.name ?? currentWeapon}
        </div>
      )}
    </div>
  );
}

/**
 * TankWars - WeaponShop React Component (src/components/WeaponShop.tsx)
 *
 * Écran de boutique d'armes rétro VGA.
 * Gère les achats tour par tour (humains un par un + IA auto).
 *
 * - Affiche l'argent du joueur courant
 * - Liste toutes les armes du WEAPON_REGISTRY avec prix, description et stock
 * - Boutons + / - pour acheter / vendre (vérification d'argent)
 * - Bouton "Prêt" pour passer au joueur suivant
 *
 * Le composant est purement présentational. La logique de séquence
 * (humains + IA auto) et la transition finale vers COMBAT sont gérées par le parent (GameCanvas).
 */

import type { Player } from '../types/player';
import { WEAPON_REGISTRY, type WeaponId, ALL_WEAPON_IDS } from '../types/weapon';
import { VGA_PALETTE } from '../types/game';

export interface WeaponShopProps {
  /** Le joueur dont c'est le tour d'acheter (humain) */
  player: Player;
  /** Index dans la séquence boutique (pour affichage "Joueur X / Y") */
  shopIndex: number;
  /** Nombre total de joueurs vivants qui font leurs achats */
  totalShoppers: number;
  /** Callback pour acheter (+1) ou vendre (-1) */
  onBuySell: (weaponId: WeaponId, delta: 1 | -1) => void;
  /** Le joueur a fini ses achats → passer au suivant (humain ou IA) */
  onReady: () => void;
}

const WEAPON_DESCRIPTIONS: Partial<Record<WeaponId, string>> = {
  MISSILE: 'Missile standard - trajectoire précise',
  GRENADE: 'Grenade à rebond - utile en terrain accidenté',
  CLUSTER: 'MIRV / Sous-munitions - multiple impacts',
  NUKE: 'Mini-Nuke - gros dégâts + large cratère',
  DRILLER: 'Foreur - perce le sol en profondeur',
};

export function WeaponShop({
  player,
  shopIndex,
  totalShoppers,
  onBuySell,
  onReady,
}: WeaponShopProps) {
  const money = player.money ?? 0;
  const inventory = player.inventory ?? {};

  return (
    <div
      style={{
        position: 'absolute',
        top: '50%',
        left: '50%',
        transform: 'translate(-50%, -50%)',
        zIndex: 25,
        pointerEvents: 'auto',
        backgroundColor: 'rgba(0, 0, 0, 0.94)',
        border: `4px solid ${VGA_PALETTE.MAGENTA}`,
        boxShadow: '0 0 0 2px #000, 0 0 0 6px #222',
        fontFamily: 'monospace',
        color: VGA_PALETTE.WHITE,
        width: 'min(520px, 92%)',
        padding: '16px 20px 20px',
        textAlign: 'center',
      }}
    >
      {/* Header */}
      <div style={{ marginBottom: 8 }}>
        <span style={{ color: VGA_PALETTE.CYAN, fontSize: '13px' }}>
          BOUTIQUE — MANCHE {shopIndex + 1} / {totalShoppers}
        </span>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, marginBottom: 12 }}>
        <span
          style={{
            display: 'inline-block',
            width: 14,
            height: 14,
            backgroundColor: player.tank.color,
            border: `2px solid ${VGA_PALETTE.WHITE}`,
            verticalAlign: 'middle',
          }}
        />
        <span style={{ color: player.tank.color, fontWeight: 'bold', fontSize: '18px' }}>
          {player.name}
        </span>
        <span style={{ color: VGA_PALETTE.YELLOW, fontSize: '20px', marginLeft: 12 }}>
          {money}$
        </span>
      </div>

      <div style={{ fontSize: '10px', color: VGA_PALETTE.GRAY, marginBottom: 10 }}>
        Utilisez + pour acheter, − pour vendre (remboursement intégral)
      </div>

      {/* Weapon list */}
      <div style={{ textAlign: 'left', marginBottom: 16 }}>
        {ALL_WEAPON_IDS.map((wid) => {
          const def = WEAPON_REGISTRY[wid];
          const currentStock = inventory[wid] ?? 0;
          const canAfford = money >= def.price;
          const canSell = currentStock > 0;

          return (
            <div
              key={wid}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '6px 8px',
                marginBottom: 5,
                backgroundColor: '#111',
                border: `1px solid ${VGA_PALETTE.DARK_GRAY}`,
              }}
            >
              {/* Weapon info */}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span style={{ color: def.color, fontWeight: 'bold' }}>{def.name}</span>
                  <span style={{ color: VGA_PALETTE.YELLOW }}>{def.price}$</span>
                </div>
                <div style={{ fontSize: '9px', color: VGA_PALETTE.GRAY, lineHeight: 1.2 }}>
                  {WEAPON_DESCRIPTIONS[wid] ?? 'Arme tactique'}
                </div>
              </div>

              {/* Stock */}
              <div style={{ textAlign: 'center', minWidth: 42, color: VGA_PALETTE.CYAN }}>
                Stock<br />
                <strong style={{ fontSize: '13px' }}>{currentStock}</strong>
              </div>

              {/* +/- buttons */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                <button
                  onClick={() => onBuySell(wid, 1)}
                  disabled={!canAfford}
                  style={{
                    fontFamily: 'monospace',
                    fontSize: '12px',
                    width: 26,
                    height: 20,
                    background: canAfford ? '#003300' : '#222',
                    color: canAfford ? VGA_PALETTE.GREEN : '#555',
                    border: `1px solid ${canAfford ? VGA_PALETTE.GREEN : VGA_PALETTE.DARK_GRAY}`,
                    cursor: canAfford ? 'pointer' : 'not-allowed',
                    padding: 0,
                  }}
                  title="Acheter 1"
                >
                  +
                </button>
                <button
                  onClick={() => onBuySell(wid, -1)}
                  disabled={!canSell}
                  style={{
                    fontFamily: 'monospace',
                    fontSize: '12px',
                    width: 26,
                    height: 20,
                    background: canSell ? '#330000' : '#222',
                    color: canSell ? VGA_PALETTE.RED : '#555',
                    border: `1px solid ${canSell ? VGA_PALETTE.RED : VGA_PALETTE.DARK_GRAY}`,
                    cursor: canSell ? 'pointer' : 'not-allowed',
                    padding: 0,
                  }}
                  title="Vendre 1"
                >
                  −
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {/* Ready button */}
      <button
        onClick={onReady}
        style={{
          padding: '10px 36px',
          fontSize: '15px',
          backgroundColor: '#222',
          color: VGA_PALETTE.WHITE,
          border: `3px solid ${VGA_PALETTE.CYAN}`,
          cursor: 'pointer',
          fontFamily: 'monospace',
          fontWeight: 'bold',
          letterSpacing: 0.5,
        }}
      >
        PRÊT → Joueur suivant
      </button>

      <div style={{ fontSize: '9px', color: VGA_PALETTE.DARK_GRAY, marginTop: 8 }}>
        Les IA achètent automatiquement
      </div>
    </div>
  );
}

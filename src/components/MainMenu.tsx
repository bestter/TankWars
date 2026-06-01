/**
 * Bestter's TankWars - MainMenu React Component (src/components/MainMenu.tsx)
 *
 * Écran d'accueil rétro DOS/VGA :
 * - Fond noir + bordure double ligne style ancien terminal
 * - Titre géant clignotant jaune VGA (#FFFF55 / blanc)
 * - Configuration joueurs (2-4) : nom + type Humain / IA Simple
 * - Attribution auto de couleurs VGA uniques (palette partagée)
 * - Au clic START : fabrique les Player[] valides + invoke callback
 *
 * Le parent (App) gère le basculement phase MENU → COMBAT et le montage du GameCanvas.
 *
 * Respecte guidelines :
 * - React hooks + TS strict (zéro any)
 * - State React pur (pas de mutation canvas)
 * - Couleurs depuis VGA_PALETTE
 */

import { useState, useMemo } from 'react';
import type { Player } from '../types/player';
import { VGA_PALETTE, type Color } from '../types/game';
import { DEFAULT_INVENTORY } from '../types/weapon';

export interface MainMenuProps {
  /** Appelé avec les joueurs initialisés (positions placeholder, spawn fait par TankManager/Engine) */
  onStartGame: (players: Player[]) => void;
}

interface PlayerConfig {
  name: string;
  isHuman: boolean;
}

/** Couleurs tanks jouables (ordre stable pour attribution auto) */
const TANK_COLOR_POOL: readonly Color[] = [
  VGA_PALETTE.RED,      // #FF5555
  VGA_PALETTE.GREEN,    // #55FF55
  VGA_PALETTE.CYAN,     // #55FFFF
  VGA_PALETTE.YELLOW,   // #FFFF55
  VGA_PALETTE.MAGENTA,  // #FF55FF
  VGA_PALETTE.BLUE,     // #5555FF
] as const;

function getDefaultName(index: number, isHuman: boolean): string {
  if (index === 0) return isHuman ? 'Bestter' : 'CPU-1';
  return isHuman ? `Joueur ${index + 1}` : `CPU-${index + 1}`;
}

export function MainMenu({ onStartGame }: MainMenuProps) {
  const [numPlayers, setNumPlayers] = useState<2 | 3 | 4>(2);
  const [playerConfigs, setPlayerConfigs] = useState<PlayerConfig[]>([
    { name: 'Bestter', isHuman: true },
    { name: 'CPU-1', isHuman: false },
  ]);

  // Couleurs auto uniques (slice du pool)
  const assignedColors = useMemo<Color[]>(() => {
    return TANK_COLOR_POOL.slice(0, numPlayers);
  }, [numPlayers]);

  // Synchronise le tableau de configs quand on change le nombre de joueurs
  const changeNumPlayers = (n: 2 | 3 | 4): void => {
    if (n === numPlayers) return;

    setNumPlayers(n);

    setPlayerConfigs((prev) => {
      const next = [...prev];

      // Ajouter des configs par défaut si on augmente
      while (next.length < n) {
        const idx = next.length;
        const defaultIsHuman = idx === 0; // premier = humain par défaut
        next.push({
          name: getDefaultName(idx, defaultIsHuman),
          isHuman: defaultIsHuman,
        });
      }

      // Tronquer si on diminue
      return next.slice(0, n);
    });
  };

  // Mise à jour immutable d'un champ d'un joueur
  const updatePlayer = (index: number, patch: Partial<PlayerConfig>): void => {
    setPlayerConfigs((prev) =>
      prev.map((cfg, i) => (i === index ? { ...cfg, ...patch } : cfg)),
    );
  };

  const handleNameChange = (index: number, value: string): void => {
    updatePlayer(index, { name: value });
  };

  const handleTypeChange = (index: number, isHuman: boolean): void => {
    updatePlayer(index, { isHuman });
  };

  // Validation légère avant start
  const canStart = playerConfigs.every((cfg) => cfg.name.trim().length > 0);

  // Crée les objets Player complets (le GameEngine / TankManager écrasera les positions via spawnTanks)
  const handleStartClick = (): void => {
    if (!canStart) return;

    const players: Player[] = playerConfigs.map((cfg, i) => {
      const color = assignedColors[i];
      const id = `player-${i + 1}`;
      const tankId = `tank-${i + 1}`;
      const trimmedName = cfg.name.trim();

      return {
        id,
        name: trimmedName,
        isHuman: cfg.isHuman,
        aiProfile: cfg.isHuman ? undefined : 'v1-random',
        tank: {
          id: tankId,
          position: { x: 80 + i * 160, y: 280 }, // placeholder (spawnTanks recalcule sur terrain)
          angle: i < Math.ceil(numPlayers / 2) ? -32 : 32,
          power: 50,
          health: 100,
          maxHealth: 100,
          shield: 40,
          maxShield: 40,
          isDead: false,
          color,
          currentWeapon: 'MISSILE',
        },
        money: 250,
        inventory: { ...DEFAULT_INVENTORY },
      };
    });

    onStartGame(players);
  };

  return (
    <div
      style={{
        minHeight: '100vh',
        background: '#000000',
        color: '#FFFFFF',
        fontFamily: 'monospace',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '12px',
      }}
    >
      <div className="retro-menu-frame">
        <div className="retro-menu-inner">
          {/* === TITRE PRINCIPAL FLASHY === */}
          <h1 className="retro-title">Bestter's TankWars</h1>

          {/* Sous-titre / description rapide */}
          <p className="retro-subtitle">
            Combat d'artillerie • Terrain 100% destructible (heightmap custom)<br />
            2 à 4 joueurs • Humains ou IA • Palette VGA 16 couleurs
          </p>

          {/* === CONFIGURATION JOUEURS === */}
          <div className="retro-section">CONFIGURATION DE LA BATAILLE</div>

          {/* Sélecteur nombre de joueurs (boutons style rétro) */}
          <div style={{ marginBottom: 10 }}>
            <span style={{ color: '#AAAAAA', fontSize: 11, marginRight: 8 }}>
              NOMBRE DE JOUEURS :
            </span>
            {[2, 3, 4].map((n) => (
              <button
                key={n}
                type="button"
                className={`retro-num-btn ${n === numPlayers ? 'active' : ''}`}
                onClick={() => changeNumPlayers(n as 2 | 3 | 4)}
              >
                {n}
              </button>
            ))}
          </div>

          {/* Liste des joueurs configurables */}
          <div style={{ marginBottom: 6 }}>
            {playerConfigs.map((cfg, index) => {
              const color = assignedColors[index];
              const isHuman = cfg.isHuman;

              return (
                <div key={index} className="retro-player-row">
                  {/* Swatch couleur VGA unique */}
                  <div
                    className="retro-color-swatch"
                    style={{ backgroundColor: color }}
                    title={`Couleur VGA ${color}`}
                  />

                  {/* Nom du joueur (éditable) */}
                  <input
                    type="text"
                    className="retro-input"
                    value={cfg.name}
                    maxLength={16}
                    onChange={(e) => handleNameChange(index, e.target.value)}
                    placeholder={`Joueur ${index + 1}`}
                    aria-label={`Nom du joueur ${index + 1}`}
                  />

                  {/* Toggle type : Humain / IA Simple (deux boutons) */}
                  <button
                    type="button"
                    className={`retro-type-btn ${isHuman ? 'active' : ''}`}
                    onClick={() => handleTypeChange(index, true)}
                    title="Contrôlé par un humain (clavier/souris)"
                  >
                    HUMAIN
                  </button>
                  <button
                    type="button"
                    className={`retro-type-btn ${!isHuman ? 'active' : ''}`}
                    onClick={() => handleTypeChange(index, false)}
                    title="IA Simple (v1-random) — Phase 1"
                  >
                    IA SIMPLE
                  </button>

                  {/* Indicateur IA / Humain compact */}
                  <span
                    style={{
                      fontSize: 9,
                      color: isHuman ? '#55FF55' : '#FFAA00',
                      marginLeft: 2,
                      minWidth: 22,
                    }}
                  >
                    {isHuman ? 'P' : 'CPU'}
                  </span>
                </div>
              );
            })}
          </div>

          <div style={{ fontSize: 10, color: '#666666', marginTop: -2, marginBottom: 8 }}>
            Les couleurs sont attribuées automatiquement depuis la palette VGA (uniques).
            Les IA utilisent la stratégie basique « v1-random ».
          </div>

          {/* === GROS BOUTON D'ACTION === */}
          <div style={{ textAlign: 'center' }}>
            <button
              type="button"
              className="retro-start-btn"
              onClick={handleStartClick}
              disabled={!canStart}
              style={{
                opacity: canStart ? 1 : 0.5,
                cursor: canStart ? 'pointer' : 'not-allowed',
              }}
            >
              COMMENCER LA BATAILLE
            </button>
          </div>

          {/* Mentions légales en bas */}
          <div className="retro-legal">
            © 2026 Bestter. All Rights Reserved. Released under MIT License.
          </div>
        </div>
      </div>
    </div>
  );
}

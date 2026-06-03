/**
 * Bestter's TankWars - MainMenu React Component (src/components/MainMenu.tsx)
 *
 * Écran d'accueil rétro DOS/VGA :
 * - Fond noir + bordure double ligne style ancien terminal
 * - Titre géant clignotant jaune VGA (#FFFF55 / blanc)
 * - Configuration joueurs (2-4) : nom + type Humain / IA Simple (Mr. Simple) / IA OK (smarter v2)
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

import { useState, useRef } from 'react';
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
  color: Color;
  /** stable identifier for React list keys (avoids array index keys) */
  id: string;
  /** Only meaningful when !isHuman. Defaults to v1 for "IA SIMPLE" (Mr. Simple). */
  aiProfile?: 'v1-random' | 'v2-heuristic' | 'v3-sniper' | 'v4-smart';
}

/** Couleurs tanks jouables (palette VGA sûre, sans conflit avec assets jeu : 
 * sol=BROWN, herbe=GREEN, ciel=DARK_BLUE, lave=DARK_RED/RED/YELLOW, 
 * et couleurs UI principales comme CYAN/MAGENTA utilisées dans HUD. 
 * Évite aussi BLACK/WHITE/GRAY pour contraste/unicité.
 */
const TANK_COLOR_POOL: readonly Color[] = [
  VGA_PALETTE.BLUE,       // #5555FF - safe
  VGA_PALETTE.DARK_CYAN,  // #00AAAA - safe
  VGA_PALETTE.DARK_MAGENTA, // #AA00AA - safe
  VGA_PALETTE.MAGENTA,    // #FF55FF - acceptable for tanks
  VGA_PALETTE.CYAN,       // #55FFFF - was in old, acceptable
  VGA_PALETTE.DARK_GREEN, // #00AA00 - distinct from grass
] as const;

function getDefaultName(index: number, isHuman: boolean): string {
  if (index === 0) return isHuman ? 'Player-1' : 'CPU-1';
  return isHuman ? `Player ${index + 1}` : `CPU-${index + 1}`;
}

export function MainMenu({ onStartGame }: MainMenuProps) {
  const [numPlayers, setNumPlayers] = useState<2 | 3 | 4>(2);
  const [playerConfigs, setPlayerConfigs] = useState<PlayerConfig[]>([
    { name: 'Player-1', isHuman: true, color: TANK_COLOR_POOL[0], id: 'p-1' },
    { name: 'CPU-1', isHuman: false, color: TANK_COLOR_POOL[1], id: 'p-2', aiProfile: 'v1-random' },
  ]);

  // Refs for name inputs, to auto-focus/select when switching a player to Human
  const nameInputRefs = useRef<(HTMLInputElement | null)[]>([]);

  // (couleurs maintenant gérées par playerConfigs, sélectionnables par l'utilisateur)

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
        const usedColors = new Set(next.map((p) => p.color));
        const available = TANK_COLOR_POOL.filter((c) => !usedColors.has(c));
        const newColor = available[0] ?? TANK_COLOR_POOL[idx % TANK_COLOR_POOL.length];
        const newCfg: PlayerConfig = {
          name: getDefaultName(idx, defaultIsHuman),
          isHuman: defaultIsHuman,
          color: newColor,
          id: `p-${Date.now()}-${idx}`,
        };
        if (!defaultIsHuman) {
          newCfg.aiProfile = 'v1-random'; // default IA SIMPLE
        }
        next.push(newCfg);
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
    if (isHuman) {
      updatePlayer(index, { isHuman, aiProfile: undefined });
    } else {
      updatePlayer(index, { isHuman, aiProfile: 'v1-random' });
    }
    if (isHuman) {
      // After re-render, focus and select the name input so user can immediately edit
      setTimeout(() => {
        const input = nameInputRefs.current[index];
        if (input) {
          input.focus();
          input.select();
        }
      }, 0);
    }
  };

  const handleColorSelect = (index: number, newColor: Color): void => {
    updatePlayer(index, { color: newColor });
  };

  // Validation légère avant start
  const canStart = playerConfigs.every((cfg) => cfg.name.trim().length > 0);

  // Crée les objets Player complets (le GameEngine / TankManager écrasera les positions via spawnTanks)
  const handleStartClick = (): void => {
    if (!canStart) return;

    const players: Player[] = playerConfigs.map((cfg, i) => {
      const color = cfg.color;
      const id = `player-${i + 1}`;
      const tankId = `tank-${i + 1}`;
      const trimmedName = cfg.name.trim();

      return {
        id,
        name: trimmedName,
        isHuman: cfg.isHuman,
        aiProfile: cfg.isHuman ? undefined : (cfg.aiProfile ?? 'v1-random'),
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
              const color = cfg.color;
              const isHuman = cfg.isHuman;

              return (
                <div key={cfg.id} className="retro-player-row">
                  {/* Liste des couleurs disponibles pour ce joueur (sélectionnées par les autres retirées).
                      La couleur courante est mise en évidence par bordure blanche.
                      Utilise <button> pour accessibilité et clavier. */}
                  <div style={{ display: 'flex', gap: '2px', flexShrink: 0, alignItems: 'center' }}>
                    {TANK_COLOR_POOL
                      .filter((c) => !playerConfigs.some((pc, pi) => pi !== index && pc.color === c))
                      .map((availColor) => {
                        const isSelected = availColor === color;
                        return (
                          <button
                            key={availColor}
                            type="button"
                            className="retro-color-swatch"
                            style={{
                              backgroundColor: availColor,
                              width: isSelected ? 16 : 12,
                              height: isSelected ? 14 : 10,
                              border: isSelected
                                ? `2px solid ${VGA_PALETTE.WHITE}`
                                : '1px solid #555555',
                              padding: 0,
                              margin: 0,
                              cursor: 'pointer',
                              flexShrink: 0,
                              boxSizing: 'border-box',
                              opacity: isSelected ? 1 : 0.85,
                            }}
                            title={availColor}
                            aria-label={`Select color ${availColor} for this player`}
                            onClick={() => handleColorSelect(index, availColor)}
                          />
                        );
                      })}
                  </div>

                  {/* Nom du joueur (éditable) */}
                  <input
                    ref={(el) => { nameInputRefs.current[index] = el; }}
                    type="text"
                    className="retro-input"
                    value={cfg.name}
                    maxLength={16}
                    onChange={(e) => handleNameChange(index, e.target.value)}
                    placeholder={`Player ${index + 1}`}
                    aria-label={`Nom du joueur ${index + 1}`}
                  />

                  {/* Select Controller Type (Humain, IA Simple, IA OK, IA Sniper, IA Expert) */}
                  <select
                    className="retro-input"
                    style={{
                      width: '120px',
                      flex: 'none',
                      fontSize: '11px',
                      padding: '2px 4px',
                      cursor: 'pointer',
                      color: isHuman ? '#55FF55' : '#FFAA00',
                      border: `1px solid ${isHuman ? '#55FF55' : '#FFAA00'}`,
                      background: '#000000',
                    }}
                    value={isHuman ? 'human' : (cfg.aiProfile ?? 'v1-random')}
                    onChange={(e) => {
                      const val = e.target.value;
                      if (val === 'human') {
                        handleTypeChange(index, true);
                      } else {
                        updatePlayer(index, {
                          isHuman: false,
                          aiProfile: val as 'v1-random' | 'v2-heuristic' | 'v3-sniper' | 'v4-smart',
                        });
                      }
                    }}
                    aria-label={`Type de contrôleur pour joueur ${index + 1}`}
                  >
                    <option value="human" style={{ color: '#55FF55', background: '#000000' }}>HUMAIN</option>
                    <option value="v1-random" style={{ color: '#FFAA00', background: '#000000' }}>IA SIMPLE</option>
                    <option value="v2-heuristic" style={{ color: '#FFAA00', background: '#000000' }}>IA OK</option>
                    <option value="v3-sniper" style={{ color: '#FFAA00', background: '#000000' }}>IA SNIPER</option>
                    <option value="v4-smart" style={{ color: '#FFAA00', background: '#000000' }}>IA EXPERT</option>
                  </select>

                  {/* Compact Status Indicator */}
                  <span
                    style={{
                      fontSize: 9,
                      color: isHuman ? '#55FF55' : '#FFAA00',
                      marginLeft: 2,
                      minWidth: 32,
                      textAlign: 'center',
                    }}
                  >
                    {isHuman ? 'P' : (
                      cfg.aiProfile === 'v2-heuristic' ? 'OK' :
                      cfg.aiProfile === 'v3-sniper' ? 'SNIP' :
                      cfg.aiProfile === 'v4-smart' ? 'EXPT' : 'CPU'
                    )}
                  </span>
                </div>
              );
            })}
          </div>

          <div style={{ fontSize: 10, color: '#666666', marginTop: -2, marginBottom: 8 }}>
            Pour chaque joueur, seule la liste des couleurs encore disponibles est affichée (les couleurs déjà choisies par les autres joueurs sont retirées).<br />
            Palette VGA sûre (exclut sol, herbe, ciel, lave et couleurs UI principales). Les couleurs doivent être uniques.
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

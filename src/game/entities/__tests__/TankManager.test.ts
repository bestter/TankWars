import { describe, it, expect } from 'vitest';
import { TankManager } from '../TankManager';
import type { Player } from '../../../types/player';
import { VGA_PALETTE } from '../../../types/game';

describe('TankManager', () => {
  describe('getAlivePlayers', () => {
    it('returns only players with alive tanks', () => {
      const tankManager = new TankManager();

      const p1: Player = {
        id: 'p1',
        name: 'Player 1',
        isHuman: true,
        money: 0,
        inventory: {},
        tank: {
          id: 't1',
          position: { x: 0, y: 0 },
          angle: 45,
          power: 50,
          health: 100,
          maxHealth: 100,
          shield: 0,
          maxShield: 0,
          isDead: false,
          color: VGA_PALETTE.RED,
          currentWeapon: 'MISSILE'
        }
      };

      const p2: Player = {
        id: 'p2',
        name: 'Player 2',
        isHuman: true,
        money: 0,
        inventory: {},
        tank: {
          id: 't2',
          position: { x: 0, y: 0 },
          angle: 45,
          power: 50,
          health: 0,
          maxHealth: 100,
          shield: 0,
          maxShield: 0,
          isDead: true,
          color: VGA_PALETTE.BLUE,
          currentWeapon: 'MISSILE'
        }
      };

      const p3: Player = {
        id: 'p3',
        name: 'Player 3',
        isHuman: true,
        money: 0,
        inventory: {},
        tank: {
          id: 't3',
          position: { x: 0, y: 0 },
          angle: 45,
          power: 50,
          health: 100,
          maxHealth: 100,
          shield: 0,
          maxShield: 0,
          isDead: false,
          color: VGA_PALETTE.GREEN,
          currentWeapon: 'MISSILE'
        }
      };

      tankManager.setPlayers([p1, p2, p3]);

      const alivePlayers = tankManager.getAlivePlayers();

      expect(alivePlayers).toHaveLength(2);
      expect(alivePlayers).toContainEqual(p1);
      expect(alivePlayers).toContainEqual(p3);
      expect(alivePlayers).not.toContainEqual(p2);
    });

    it('returns an empty array when all players are dead', () => {
      const tankManager = new TankManager();

      const p1: Player = {
        id: 'p1',
        name: 'Player 1',
        isHuman: true,
        money: 0,
        inventory: {},
        tank: {
          id: 't1',
          position: { x: 0, y: 0 },
          angle: 45,
          power: 50,
          health: 0,
          maxHealth: 100,
          shield: 0,
          maxShield: 0,
          isDead: true,
          color: VGA_PALETTE.RED,
          currentWeapon: 'MISSILE'
        }
      };

      tankManager.setPlayers([p1]);

      const alivePlayers = tankManager.getAlivePlayers();

      expect(alivePlayers).toHaveLength(0);
    });

    it('returns an empty array when there are no players', () => {
      const tankManager = new TankManager();
      tankManager.setPlayers([]);
      const alivePlayers = tankManager.getAlivePlayers();
      expect(alivePlayers).toHaveLength(0);
    });
  });
});

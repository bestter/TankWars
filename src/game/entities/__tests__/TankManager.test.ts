import { describe, it, expect } from 'vitest';
import { TankManager } from '../TankManager';
import type { Player } from '../../../types/player';
import { VGA_PALETTE } from '../../../types/game';

function createDummyPlayer(id: string, isDead: boolean): Player {
  return {
    id,
    name: `Player ${id}`,
    isHuman: true,
    money: 0,
    inventory: {},
    tank: {
      id: `t${id}`,
      position: { x: 0, y: 0 },
      angle: 45,
      power: 50,
      health: isDead ? 0 : 100,
      maxHealth: 100,
      shield: 0,
      maxShield: 0,
      isDead,
      color: VGA_PALETTE.RED,
      currentWeapon: 'MISSILE'
    }
  };
}

describe('TankManager', () => {
  describe('getAlivePlayers', () => {
    it('returns only players with alive tanks', () => {
      const tankManager = new TankManager();

      const p1 = createDummyPlayer('1', false);
      const p2 = createDummyPlayer('2', true);
      const p3 = createDummyPlayer('3', false);

      tankManager.setPlayers([p1, p2, p3]);

      const alivePlayers = tankManager.getAlivePlayers();

      expect(alivePlayers).toHaveLength(2);
      expect(alivePlayers).toContainEqual(p1);
      expect(alivePlayers).toContainEqual(p3);
      expect(alivePlayers).not.toContainEqual(p2);
    });

    it('returns all players when all are alive', () => {
      const tankManager = new TankManager();
      const p1 = createDummyPlayer('1', false);
      const p2 = createDummyPlayer('2', false);
      tankManager.setPlayers([p1, p2]);

      const alivePlayers = tankManager.getAlivePlayers();
      expect(alivePlayers).toHaveLength(2);
      expect(alivePlayers).toContainEqual(p1);
      expect(alivePlayers).toContainEqual(p2);
    });

    it('returns an empty array when all players are dead', () => {
      const tankManager = new TankManager();
      const p1 = createDummyPlayer('1', true);
      const p2 = createDummyPlayer('2', true);
      tankManager.setPlayers([p1, p2]);

      const alivePlayers = tankManager.getAlivePlayers();
      expect(alivePlayers).toHaveLength(0);
    });

    it('returns an empty array when there are no players', () => {
      const tankManager = new TankManager();
      tankManager.setPlayers([]);
      const alivePlayers = tankManager.getAlivePlayers();
      expect(alivePlayers).toHaveLength(0);
    });

    it('preserves the original order of players', () => {
      const tankManager = new TankManager();
      const p1 = createDummyPlayer('1', false);
      const p2 = createDummyPlayer('2', true);
      const p3 = createDummyPlayer('3', false);
      const p4 = createDummyPlayer('4', true);
      const p5 = createDummyPlayer('5', false);

      tankManager.setPlayers([p1, p2, p3, p4, p5]);

      const alivePlayers = tankManager.getAlivePlayers();
      expect(alivePlayers).toEqual([p1, p3, p5]);
    });

    it('returns a new array instance, not mutating the original', () => {
      const tankManager = new TankManager();
      const p1 = createDummyPlayer('1', false);
      const p2 = createDummyPlayer('2', false);

      const originalPlayers = [p1, p2];
      tankManager.setPlayers(originalPlayers);

      const alivePlayers = tankManager.getAlivePlayers();
      expect(alivePlayers).not.toBe(originalPlayers); // should be a different reference
      expect(alivePlayers).toEqual(originalPlayers); // but contain same items

      // Mutating the returned array should not affect original
      alivePlayers.push(createDummyPlayer('3', false));
      expect(tankManager.getPlayers()).toHaveLength(2);
    });

    it('reflects dynamic state changes in isDead', () => {
      const tankManager = new TankManager();
      const p1 = createDummyPlayer('1', false);
      const p2 = createDummyPlayer('2', false);

      tankManager.setPlayers([p1, p2]);

      expect(tankManager.getAlivePlayers()).toHaveLength(2);

      // Simulate tank dying during gameplay
      p1.tank.isDead = true;

      const aliveAfterDeath = tankManager.getAlivePlayers();
      expect(aliveAfterDeath).toHaveLength(1);
      expect(aliveAfterDeath[0]).toBe(p2);
    });
  });

  describe('getWinner', () => {
    it('returns the winner when only one player is alive', () => {
      const tankManager = new TankManager();
      const p1 = createDummyPlayer('1', false);
      const p2 = createDummyPlayer('2', true);
      tankManager.setPlayers([p1, p2]);

      const winner = tankManager.getWinner();
      expect(winner).toEqual(p1);
    });

    it('returns null when more than one player is alive', () => {
      const tankManager = new TankManager();
      const p1 = createDummyPlayer('1', false);
      const p2 = createDummyPlayer('2', false);
      tankManager.setPlayers([p1, p2]);

      const winner = tankManager.getWinner();
      expect(winner).toBeNull();
    });

    it('returns null when all players are dead', () => {
      const tankManager = new TankManager();
      const p1 = createDummyPlayer('1', true);
      const p2 = createDummyPlayer('2', true);
      tankManager.setPlayers([p1, p2]);

      const winner = tankManager.getWinner();
      expect(winner).toBeNull();
    });

    it('returns null when there are no players', () => {
      const tankManager = new TankManager();
      tankManager.setPlayers([]);

      const winner = tankManager.getWinner();
      expect(winner).toBeNull();
    });
  });
});

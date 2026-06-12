import { describe, it, expect } from "vitest";
import { TankManager } from "../TankManager";
import type { Player } from "../../../types/player";
import { VGA_PALETTE } from "../../../types/game";
import { TerrainManager } from "../../engine/Terrain";

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
      currentWeapon: "MISSILE",
    },
  };
}

describe("TankManager", () => {
  describe("getAlivePlayers", () => {
    it("returns only players with alive tanks", () => {
      const tankManager = new TankManager();

      const p1 = createDummyPlayer("1", false);
      const p2 = createDummyPlayer("2", true);
      const p3 = createDummyPlayer("3", false);

      tankManager.setPlayers([p1, p2, p3]);

      const alivePlayers = tankManager.getAlivePlayers();

      expect(alivePlayers).toHaveLength(2);
      expect(alivePlayers).toContainEqual(p1);
      expect(alivePlayers).toContainEqual(p3);
      expect(alivePlayers).not.toContainEqual(p2);
    });

    it("returns all players when all are alive", () => {
      const tankManager = new TankManager();
      const p1 = createDummyPlayer("1", false);
      const p2 = createDummyPlayer("2", false);
      tankManager.setPlayers([p1, p2]);

      const alivePlayers = tankManager.getAlivePlayers();
      expect(alivePlayers).toHaveLength(2);
      expect(alivePlayers).toContainEqual(p1);
      expect(alivePlayers).toContainEqual(p2);
    });

    it("returns an empty array when all players are dead", () => {
      const tankManager = new TankManager();
      const p1 = createDummyPlayer("1", true);
      const p2 = createDummyPlayer("2", true);
      tankManager.setPlayers([p1, p2]);

      const alivePlayers = tankManager.getAlivePlayers();
      expect(alivePlayers).toHaveLength(0);
    });

    it("returns an empty array when there are no players", () => {
      const tankManager = new TankManager();
      tankManager.setPlayers([]);
      const alivePlayers = tankManager.getAlivePlayers();
      expect(alivePlayers).toHaveLength(0);
    });

    it("preserves the original order of players", () => {
      const tankManager = new TankManager();
      const p1 = createDummyPlayer("1", false);
      const p2 = createDummyPlayer("2", true);
      const p3 = createDummyPlayer("3", false);
      const p4 = createDummyPlayer("4", true);
      const p5 = createDummyPlayer("5", false);

      tankManager.setPlayers([p1, p2, p3, p4, p5]);

      const alivePlayers = tankManager.getAlivePlayers();
      expect(alivePlayers).toEqual([p1, p3, p5]);
    });

    it("returns a new array instance, not mutating the original", () => {
      const tankManager = new TankManager();
      const p1 = createDummyPlayer("1", false);
      const p2 = createDummyPlayer("2", false);

      const originalPlayers = [p1, p2];
      tankManager.setPlayers(originalPlayers);

      const alivePlayers = tankManager.getAlivePlayers();
      expect(alivePlayers).not.toBe(originalPlayers); // should be a different reference
      expect(alivePlayers).toEqual(originalPlayers); // but contain same items

      // Mutating the returned array should not affect original
      alivePlayers.push(createDummyPlayer("3", false));
      expect(tankManager.getPlayers()).toHaveLength(2);
    });

    it("reflects dynamic state changes in isDead", () => {
      const tankManager = new TankManager();
      const p1 = createDummyPlayer("1", false);
      const p2 = createDummyPlayer("2", false);

      tankManager.setPlayers([p1, p2]);

      expect(tankManager.getAlivePlayers()).toHaveLength(2);

      // Simulate tank dying during gameplay
      p1.tank.isDead = true;
      (
        tankManager as unknown as { invalidateAliveCache: () => void }
      ).invalidateAliveCache();

      const aliveAfterDeath = tankManager.getAlivePlayers();
      expect(aliveAfterDeath).toHaveLength(1);
      expect(aliveAfterDeath[0]).toBe(p2);
    });
  });

  describe("getWinner", () => {
    it("returns the winner when only one player is alive", () => {
      const tankManager = new TankManager();
      const p1 = createDummyPlayer("1", false);
      const p2 = createDummyPlayer("2", true);
      tankManager.setPlayers([p1, p2]);

      const winner = tankManager.getWinner();
      expect(winner).toEqual(p1);
    });

    it("returns null when more than one player is alive", () => {
      const tankManager = new TankManager();
      const p1 = createDummyPlayer("1", false);
      const p2 = createDummyPlayer("2", false);
      tankManager.setPlayers([p1, p2]);

      const winner = tankManager.getWinner();
      expect(winner).toBeNull();
    });

    it("returns null when all players are dead", () => {
      const tankManager = new TankManager();
      const p1 = createDummyPlayer("1", true);
      const p2 = createDummyPlayer("2", true);
      tankManager.setPlayers([p1, p2]);

      const winner = tankManager.getWinner();
      expect(winner).toBeNull();
    });

    it("returns null when there are no players", () => {
      const tankManager = new TankManager();
      tankManager.setPlayers([]);

      const winner = tankManager.getWinner();
      expect(winner).toBeNull();
    });
  });

  describe("spawnTanks", () => {
    it("places tanks with minimum distance and margin constraints on terrain ground level", () => {
      const tankManager = new TankManager();
      const terrain = new TerrainManager(800, 600);
      // Remplir le terrain avec une hauteur fixe pour tester
      const heights = (terrain as unknown as { heights: number[] }).heights;
      heights.fill(300);

      const p1 = createDummyPlayer("1", false);
      const p2 = createDummyPlayer("2", false);
      const p3 = createDummyPlayer("3", false);

      tankManager.spawnTanks([p1, p2, p3], terrain);

      const margin = 800 * 0.13; // 104
      const minX = margin;
      const maxX = 800 - margin; // 696

      // Vérifier que chaque tank est bien positionné sur la hauteur du terrain (Y=300)
      // et que ses coordonnées X respectent les limites et la distance minimale.
      const positions = [p1.tank.position, p2.tank.position, p3.tank.position];

      for (const pos of positions) {
        expect(pos.y).toBe(300);
        expect(pos.x).toBeGreaterThanOrEqual(minX);
        expect(pos.x).toBeLessThanOrEqual(maxX);
      }

      // Vérifier la distance minimale
      expect(
        Math.abs(p1.tank.position.x - p2.tank.position.x),
      ).toBeGreaterThanOrEqual(100);
      expect(
        Math.abs(p1.tank.position.x - p3.tank.position.x),
      ).toBeGreaterThanOrEqual(100);
      expect(
        Math.abs(p2.tank.position.x - p3.tank.position.x),
      ).toBeGreaterThanOrEqual(100);
    });

    it("shuffles start positions randomly across multiple runs instead of keeping fixed player order", () => {
      // Pour s'assurer du mélange, on appelle spawnTanks plusieurs fois et on vérifie
      // que l'ordre des coordonnées X des joueurs n'est pas toujours trié par ID (ex. p1.x < p2.x < p3.x).
      const tankManager = new TankManager();
      const terrain = new TerrainManager(800, 600);

      let p1LeftOfP2Count = 0;
      let p2LeftOfP1Count = 0;

      const runs = 20;
      for (let r = 0; r < runs; r++) {
        const p1 = createDummyPlayer("1", false);
        const p2 = createDummyPlayer("2", false);

        tankManager.spawnTanks([p1, p2], terrain);

        if (p1.tank.position.x < p2.tank.position.x) {
          p1LeftOfP2Count++;
        } else {
          p2LeftOfP1Count++;
        }
      }

      // Avec 20 runs, la probabilité d'obtenir 20 fois le même ordre est (1/2)^20 ~= 1/1,000,000.
      // Donc si le shuffle fonctionne, les deux compteurs doivent être strictement supérieurs à 0.
      expect(p1LeftOfP2Count).toBeGreaterThan(0);
      expect(p2LeftOfP1Count).toBeGreaterThan(0);
    });
  });
});

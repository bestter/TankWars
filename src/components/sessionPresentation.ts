import { VGA_PALETTE } from "../types/game";
import type { Player } from "../types/player";
import { DEFAULT_INVENTORY } from "../types/weapon";
import type { EarningsOverlayState } from "./gameCanvasReducer";

export function createDemoPlayers(): Player[] {
  return [
    {
      id: "player-1",
      name: "You",
      isHuman: true,
      tank: {
        id: "tank-1",
        position: { x: 180, y: 320 },
        angle: 45,
        power: 50,
        health: 100,
        maxHealth: 100,
        shield: 40,
        maxShield: 40,
        isDead: false,
        color: VGA_PALETTE.BLUE,
        currentWeapon: "MISSILE",
      },
      money: 200,
      inventory: { ...DEFAULT_INVENTORY },
    },
    {
      id: "player-2",
      name: "AI Bot",
      isHuman: false,
      tank: {
        id: "tank-2",
        position: { x: 620, y: 295 },
        angle: 135,
        power: 50,
        health: 100,
        maxHealth: 100,
        shield: 40,
        maxShield: 40,
        isDead: false,
        color: VGA_PALETTE.RED,
        currentWeapon: "MISSILE",
      },
      money: 200,
      inventory: { ...DEFAULT_INVENTORY },
    },
  ];
}

export function buildOverlayAwards(
  awards: ReadonlyArray<{ playerId: string; amount: number }>,
  roster: ReadonlyArray<Player>,
): EarningsOverlayState["awards"] {
  const playersById = new Map(roster.map((player) => [player.id, player]));
  const overlayAwards: EarningsOverlayState["awards"] = [];
  for (const award of awards) {
    if (award.amount <= 0) continue;
    const player = playersById.get(award.playerId);
    if (!player) continue;
    overlayAwards.push({
      playerId: player.id,
      playerName: player.name,
      color: player.tank.color,
      amount: award.amount,
      x: player.tank.position.x,
      y: player.tank.position.y,
    });
  }
  return overlayAwards;
}

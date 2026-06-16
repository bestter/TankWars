/**
 * TankWars Online - Shared network / room protocol types (strict, zero any).
 * Used by the client OnlineLobby + useGameSession (online mode) and by the Cloudflare Worker/DO.
 */

import type { Player } from './player';
import type { WeaponId } from './weapon';

/** Configuration chosen by the host when creating the room. */
export interface RoomSlotConfig {
  type: 'human' | 'ai';
  /** Only for type === 'ai' */
  aiProfile?: 'v1-random' | 'v2-heuristic' | 'v3-sniper' | 'v4-smart';
}

export interface CreateRoomRequest {
  numPlayers: 2 | 3 | 4;
  /** Exactly numPlayers entries. Order = slot 0..N-1 */
  slots: RoomSlotConfig[];
}

export interface RoomSlotInfo {
  slot: number;
  type: 'human' | 'ai';
  aiProfile?: string;
  /** Full absolute URL the player must open (only present for human slots) */
  url: string | null;
}

export interface CreateRoomResponse {
  ok: true;
  roomId: string;
  numPlayers: number;
  slots: RoomSlotInfo[];
}

/** Message sent by client over WS when it is their turn and they fire. */
export interface ClientFireMessage {
  type: 'FIRE';
  command: {
    readonly angle: number;
    readonly power: number;
    readonly weaponId: WeaponId;
  };
}

/** Broadcast by server so every client can replay the nice projectile animation locally. */
export interface ServerShotMessage {
  type: 'SHOT';
  slot: number;
  command: ClientFireMessage['command'];
  ownerId?: string;
  ownerColor?: string;
}

/** Authoritative snapshot / delta from the server after a resolution (or initial state). */
export interface ServerStateUpdate {
  type: 'STATE_UPDATE';
  players: Player[];
  /** Full heightmap (server is source of truth). Small enough (~800 numbers). */
  heights: number[];
  wind: number;
  currentPlayerIndex: number;
  roundEnded: boolean;
}

/** Sent once when the lobby is full and the game begins (MVP = 1 round). */
export interface ServerGameStartMessage {
  type: 'GAME_START';
  players: Player[];
  heights: number[];
  wind: number;
  currentPlayerIndex: number;
}

/** Roster update while still in the waiting lobby (human names + AI placeholders). */
export interface ServerRosterUpdate {
  type: 'ROSTER_UPDATE';
  roster: Array<{ slot: number; name: string; type: 'human' | 'ai' }>;
  numPlayers: number;
}

export type ServerGameMessage =
  | ServerGameStartMessage
  | ServerShotMessage
  | ServerStateUpdate
  | ServerRosterUpdate;

export type ClientGameMessage = ClientFireMessage;

/** Internal / helper for the DO (not sent on wire) */
export interface RoomConfig {
  roomId: string;
  numPlayers: 2 | 3 | 4;
  slotConfigs: RoomSlotConfig[];
}

/**
 * TankWars Online - Shared network / room protocol types (strict, zero any).
 * Used by the client OnlineLobby + useGameSession (online mode) and by the Cloudflare Worker/DO.
 */

import type { Player } from './player';
import type { TerrainMaterial } from './terrain';
import type {
  ClientFireMessage,
  ShotMessage,
  StateUpdateMessage,
} from '../game/online/protocol';

/** Configuration chosen by the host when creating the room. */
export interface RoomSlotConfig {
  type: 'human' | 'ai';
  /** Only for type === 'ai' */
  aiProfile?: 'v1-random' | 'v2-heuristic' | 'v3-sniper' | 'v4-smart';
  id?: string;
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

/** Shared strict combat protocol aliases. */
export type { ClientFireMessage };
export type ServerShotMessage = ShotMessage;

/** Shared protocol alias; protocol.ts owns the wire contract. */
export type ServerStateUpdate = StateUpdateMessage;

/** Sent once when the lobby is full and the game begins (MVP = 1 round). */
export interface ServerGameStartMessage {
  type: 'GAME_START';
  players: Player[];
  heights: number[];
  /** Présent seulement quand le serveur a vraiment généré le terrain. */
  materials?: TerrainMaterial[];
  wind: number;
  currentPlayerIndex: number;
}

/** Roster update while still in the waiting lobby (human names + AI placeholders). */
export interface ServerRosterUpdate {
  type: 'ROSTER_UPDATE';
  roster: Array<{ slot: number; name: string; type: 'human' | 'ai' }>;
  numPlayers: number;
  /** True when the match has already started (late reconnect / catch-up). */
  gameStarted?: boolean;
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

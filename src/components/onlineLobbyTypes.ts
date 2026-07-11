import type { Player } from '../types/player';

export type LobbyView = 'create' | 'waiting' | 'joining';

export interface SlotUI {
  slot: number;
  type: 'human' | 'ai';
  aiProfile?: string;
  url: string | null; // only for humans after create
}

export interface JoinedInfo {
  slot: number;
  name: string;
  type: 'human' | 'ai';
}

export interface OnlineLobbyProps {
  /** When provided via URL params we are in "join" mode for that slot */
  initialRoomId?: string;
  initialSlot?: number;
  initialToken?: string;

  /** Called when the game actually starts (server sent GAME_START). Parent transitions to GameCanvas. */
  onStartGame: (players: Player[], meta: {
    roomId: string;
    localPlayerId: string;
    gameMode: 'online';
    initialHeights?: number[];
    initialWind?: number;
    initialCurrentPlayerIndex?: number;
    slot?: number;
    token?: string;
    ws?: WebSocket;
  }) => void;

  /** Optional: return to the pure local MainMenu */
  onExitToLocalMenu?: () => void;
}

import { useEffect, type MutableRefObject } from "react";
import type { GameEngine } from "../game/engine/GameEngine";
import type { GamePhase } from "../types/game";
import type { Player } from "../types/player";
import type { TerrainMaterial } from "../types/terrain";
import {
  clearOnlineSession,
  persistOnlineSession,
} from "../utils/onlineSession";
import type {
  EarningsOverlayState,
  PendingFireIntent,
  ShopClientSessionState,
} from "./gameCanvasReducer";
import type { FireRejectedReason } from "../game/online/protocol";
import type { RoundResult } from "../types/game";

export function usePersistOnlineCanvas(opts: {
  readonly gameMode: "local" | "online";
  readonly roomId?: string;
  readonly slot?: number;
  readonly token?: string;
  readonly localPlayerId?: string;
  readonly gamePhase: GamePhase;
  readonly currentManche: number;
  readonly uiPlayers: Player[];
  readonly shopPlayers: Player[];
  readonly currentShopIndex: number;
  readonly roundResult: RoundResult | null;
  readonly lastRoundOutcome: { isDraw: boolean; winner: Player | null } | null;
  readonly canvasWind: number;
  readonly initialPlayers?: Player[];
  readonly initialHeights?: number[];
  readonly initialMaterials?: TerrainMaterial[];
  readonly initialWind?: number;
  readonly initialCurrentPlayerIndex?: number;
  readonly earningsOverlay: EarningsOverlayState | null;
  readonly shopSession: ShopClientSessionState;
  readonly lastAppliedShopEpoch: number;
  readonly lastCompletedRoundNumber: number;
  readonly lastSeenShotId: number;
  readonly pendingFireIntent: PendingFireIntent | null;
  readonly fireRejection: FireRejectedReason | null;
  readonly engineRef: MutableRefObject<GameEngine | null>;
  readonly authoritySlotRef: MutableRefObject<number | null>;
  readonly authorityEpochRef: MutableRefObject<number>;
  readonly lastAppliedShotIdRef: MutableRefObject<number>;
  readonly lastAppliedZeusStrikeIdRef: MutableRefObject<number>;
}): void {
  const {
    gameMode,
    roomId,
    slot,
    token,
    localPlayerId,
    gamePhase,
    currentManche,
    uiPlayers,
    shopPlayers,
    currentShopIndex,
    roundResult,
    lastRoundOutcome,
    canvasWind,
    initialPlayers,
    initialHeights,
    initialMaterials,
    initialWind,
    initialCurrentPlayerIndex,
    earningsOverlay,
    shopSession,
    lastAppliedShopEpoch,
    lastCompletedRoundNumber,
    lastSeenShotId,
    pendingFireIntent,
    fireRejection,
    engineRef,
    authoritySlotRef,
    authorityEpochRef,
    lastAppliedShotIdRef,
    lastAppliedZeusStrikeIdRef,
  } = opts;

  useEffect(() => {
    if (
      gameMode !== "online" ||
      !roomId ||
      slot == null ||
      !token ||
      !localPlayerId
    ) {
      return;
    }
    if (gamePhase === "GAME_OVER") {
      clearOnlineSession();
      return;
    }
    const roster = uiPlayers.length > 0 ? uiPlayers : (initialPlayers ?? []);
    if (roster.length < 2) return;

    persistOnlineSession({
      meta: {
        roomId,
        localPlayerId,
        slot,
        token,
        initialHeights,
        initialMaterials,
        initialWind,
        initialCurrentPlayerIndex,
      },
      players: roster,
      canvas: {
        gamePhase,
        currentManche,
        uiPlayers: roster,
        shopPlayers,
        currentShopIndex,
        roundResult,
        lastRoundOutcome,
        wind: canvasWind,
        authoritySlot: authoritySlotRef.current,
        authorityEpoch: authorityEpochRef.current,
        lastAppliedShotId: lastAppliedShotIdRef.current,
        lastAppliedZeusStrikeId: lastAppliedZeusStrikeIdRef.current,
        roundEarningsByPlayer:
          engineRef.current?.getRoundEarningsByPlayer() ??
          roundResult?.earningsByPlayer ??
          {},
        earningsOverlay,
        shopSession,
        lastAppliedShopEpoch,
        lastCompletedRoundNumber,
        lastSeenShotId,
        pendingFireIntent,
        fireRejection,
      },
    });
  }, [
    gameMode,
    roomId,
    slot,
    token,
    localPlayerId,
    gamePhase,
    currentManche,
    uiPlayers,
    shopPlayers,
    currentShopIndex,
    roundResult,
    lastRoundOutcome,
    canvasWind,
    initialPlayers,
    initialHeights,
    initialMaterials,
    initialWind,
    initialCurrentPlayerIndex,
    earningsOverlay,
    shopSession,
    lastAppliedShopEpoch,
    lastCompletedRoundNumber,
    lastSeenShotId,
    pendingFireIntent,
    fireRejection,
    engineRef,
    authoritySlotRef,
    authorityEpochRef,
    lastAppliedShotIdRef,
    lastAppliedZeusStrikeIdRef,
  ]);
}

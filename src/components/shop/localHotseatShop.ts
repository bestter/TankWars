import type { Dispatch, MutableRefObject } from "react";
import type { GameEngine } from "../../game/engine/GameEngine";
import { autoBuyForAI } from "../../game/entities/ai/aiShopHelper";
import type { GamePhase } from "../../types/game";
import type { Player } from "../../types/player";
import type {
  GameCanvasAction,
  ShopClientSessionState,
} from "../gameCanvasReducer";

export interface LocalHotseatShopHost {
  readonly gameMode: "local" | "online";
  readonly engineRef: MutableRefObject<GameEngine | null>;
  readonly shopPlayersRef: MutableRefObject<Player[]>;
  readonly currentShopIndexRef: MutableRefObject<number>;
  readonly shopSessionRef: MutableRefObject<ShopClientSessionState>;
  readonly shopFinishingRef: MutableRefObject<boolean>;
  readonly gamePhaseRef: MutableRefObject<GamePhase>;
  readonly shopAiTimeoutRef: MutableRefObject<ReturnType<typeof setTimeout> | null>;
  readonly dispatch: Dispatch<GameCanvasAction>;
  readonly clearShopAiTimeout: () => void;
  readonly finishShopPhase: () => void;
}

function copySafeInventory(player: Player): Player {
  const safeInventory = Object.create(null) as NonNullable<Player["inventory"]>;
  if (player.inventory && typeof player.inventory === "object") {
    for (const k in player.inventory) {
      if (Object.prototype.hasOwnProperty.call(player.inventory, k)) {
        if (k !== "__proto__" && k !== "prototype" && k !== "constructor") {
          (safeInventory as Record<string, unknown>)[k] = (
            player.inventory as Record<string, unknown>
          )[k];
        }
      }
    }
  }
  return { ...player, inventory: safeInventory };
}

export function advanceToNextShopper(host: LocalHotseatShopHost): void {
  if (host.gameMode === "online") return;

  const currentLen = host.shopPlayersRef.current.length;
  const nextIndex = host.currentShopIndexRef.current + 1;

  if (nextIndex >= currentLen) {
    host.finishShopPhase();
    return;
  }

  host.dispatch({ type: "ADVANCE_SHOPPER", nextIndex });
  host.currentShopIndexRef.current = nextIndex;

  const nextPlayer = host.shopPlayersRef.current[nextIndex];
  if (nextPlayer && !nextPlayer.isHuman) {
    host.clearShopAiTimeout();
    host.shopAiTimeoutRef.current = setTimeout(() => {
      host.shopAiTimeoutRef.current = null;
      processNextShopperIfAI(host);
    }, 80);
  }
}

export function processNextShopperIfAI(host: LocalHotseatShopHost): void {
  if (host.shopFinishingRef.current || host.gamePhaseRef.current !== "SHOP") {
    return;
  }
  if (host.gameMode === "online") return;

  const currentLen = host.shopPlayersRef.current.length;
  if (currentLen === 0) return;
  const idx = host.currentShopIndexRef.current;
  const current = host.shopPlayersRef.current[idx];
  if (!current || current.isHuman) return;

  const autoBuy = autoBuyForAI(
    copySafeInventory(current),
    host.shopSessionRef.current.counters,
  );
  const engine = host.engineRef.current;
  const basePlayers = engine
    ? engine.getTankManager().getPlayers()
    : host.shopPlayersRef.current;
  const updatedPlayers = basePlayers.map((player) =>
    player.id === current.id ? autoBuy.player : player,
  );

  if (engine) {
    engine.getTankManager().setPlayers(updatedPlayers);
  }
  host.shopPlayersRef.current = updatedPlayers;
  host.shopSessionRef.current = {
    ...host.shopSessionRef.current,
    counters: autoBuy.counters,
  };
  host.dispatch({
    type: "APPLY_LOCAL_SHOP_TRANSACTION",
    players: updatedPlayers,
    counters: autoBuy.counters,
    denial: null,
  });

  advanceToNextShopper(host);
}

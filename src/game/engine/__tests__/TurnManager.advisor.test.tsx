// @vitest-environment jsdom
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import i18next from "i18next";
import { I18nextProvider } from "react-i18next";
import { TurnManager } from "../TurnManager";
import { TankManager } from "../../entities/TankManager";
import { flatTerrain, makePlayer, makeTank } from "../../__tests__/helpers";
import fr from "../../../locales/fr.json";
import en from "../../../locales/en.json";
import { PlayerStatusList } from "../../../components/PlayerStatusList";
import type { PlayerStatusCard } from "../../../components/playerStatus";

function fixture() {
  const players = [makePlayer({ id: "self", isHuman: true, inventory: { NUKE: 1 },
    tank: makeTank("self", 100, 336) }), makePlayer({ id: "other", isHuman: true, tank: makeTank("other", 400, 336) })];
  const tanks = new TankManager(); tanks.setPlayers(players);
  const fire = vi.fn();
  const manager = new TurnManager(tanks, flatTerrain(800, 480), fire);
  manager.setLocalShotContextProvider(() => ({ playerCountAtMatchStart: 2, isFirstShotOfRound: true }));
  return { manager, tanks, players, fire };
}
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("atomic human advisor controls", () => {
  it("captures a deep canonical snapshot independent of manual controls and without mutations", () => {
    const f = fixture(); const before = structuredClone(f.players);
    const first = f.manager.captureAdvisorState();
    expect(first).not.toBeNull();
    const canonical = structuredClone(first);
    first!.players[0].tank.health = 0;
    expect(f.players).toEqual(before);
    f.manager.adjustAngle(20); f.manager.adjustPower(10); f.manager.selectWeapon("NUKE");
    expect(f.manager.captureAdvisorState()).toEqual(canonical);
  });

  it("applies all three controls together even when the weapon is already selected, never firing", () => {
    const f = fixture(); const hud = vi.fn(); f.manager.onHudUpdate = hud;
    const beforeStock = structuredClone(f.players[0].inventory);
    expect(f.manager.applyAdvisorCommand({ angle: 60, power: 70, weaponId: "MISSILE" })).toBe(true);
    expect(f.players[0].tank).toMatchObject({ angle: 60, power: 70, currentWeapon: "MISSILE" });
    expect(hud).toHaveBeenCalledOnce(); expect(f.fire).not.toHaveBeenCalled();
    expect(f.players[0].inventory).toEqual(beforeStock);
  });

  it.each(["stock", "dead", "falling", "paused", "zeus", "catchup", "ai", "ended", "bounds"])("rejects %s before any mutation", (reason) => {
    const f = fixture();
    switch (reason) {
      case "stock": f.players[0].inventory.NUKE = 0; break;
      case "dead": f.players[0].tank.isDead = true; break;
      case "falling": vi.spyOn(f.tanks, "anyTankIsFalling").mockReturnValue(true); break;
      case "paused": f.manager.pauseForInterRound(); break;
      case "zeus": f.manager.lockSpecialTurn(); break;
      case "catchup": f.manager.lockForCatchUp(); break;
      case "ai": f.players[0].isHuman = false; break;
      case "ended": f.manager.setMatchEndedChecker(() => true); break;
    }
    const before = structuredClone(f.players);
    expect(f.manager.applyAdvisorCommand({ angle: reason === "bounds" ? 999 : 60, power: 70, weaponId: "NUKE" })).toBe(false);
    expect(f.players).toEqual(before); expect(f.fire).not.toHaveBeenCalled();
  });

  it("keyboard activation on an advisor button never fires the tank", () => {
    const f = fixture(); f.manager.setupInputListeners();
    const button = document.createElement("button"); document.body.append(button);
    button.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }));
    expect(f.fire).not.toHaveBeenCalled();
    f.manager.removeInputListeners(); button.remove();
  });

  it("Enter and Space lock a target without aiming, applying advice or firing", async () => {
    const f = fixture();
    const apply = vi.spyOn(f.manager, "applyAdvisorCommand");
    const before = { angle: f.players[0].tank.angle, power: f.players[0].tank.power };
    const cards: PlayerStatusCard[] = f.players.map((player) => ({
      id: player.id, name: player.name, color: player.tank.color, isHuman: player.isHuman,
      aiProfile: player.aiProfile ?? null, health: player.tank.health, maxHealth: player.tank.maxHealth,
      shield: player.tank.shield, maxShield: player.tank.maxShield, inventory: player.inventory,
    }));
    function Harness() {
      const [lockedTargetId, setLockedTargetId] = useState<string | undefined>();
      return (
        <PlayerStatusList
          players={cards}
          currentPlayerId="self"
          gameMode="local"
          lockedTargetId={lockedTargetId}
          onToggleLock={(playerId) => setLockedTargetId((current) => current === playerId ? undefined : playerId)}
        />
      );
    }
    const i18n = i18next.createInstance();
    await i18n.init({ lng: "fr", resources: { fr: { translation: fr }, en: { translation: en } }, interpolation: { escapeValue: false } });
    render(<I18nextProvider i18n={i18n}><Harness /></I18nextProvider>);
    f.manager.setupInputListeners();
    const user = userEvent.setup();
    const button = screen.getByRole("button", { name: "Verrouiller Player 1" });
    button.focus();
    await user.keyboard("{Enter}");
    expect(button.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "Cible verrouillée : Player 1" }).textContent).toBe("Cible verrouillée");
    await user.keyboard(" ");
    expect(button.getAttribute("aria-pressed")).toBe("false");
    expect(button.textContent).toBe("Verrouiller la cible");
    expect(f.fire).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();
    expect(f.players[0].tank).toMatchObject(before);
    expect(f.players[1].tank).toMatchObject(before);
    f.manager.removeInputListeners();
  });
});

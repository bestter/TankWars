// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act, cleanup } from "@testing-library/react";
import { CombatStatusAnnouncer } from "../CombatStatusAnnouncer";
import type { CurrentTurnInfo } from "../../game/engine/TurnManager";
import { VGA_PALETTE } from "../../types/game";
import fr from "../../locales/fr.json";
import en from "../../locales/en.json";

const currentLang = vi.hoisted(() => ({ lang: "fr" }));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      const dict = (currentLang.lang === "fr" ? fr : en) as Record<string, unknown>;
      const raw = dict[key];
      if (typeof raw !== "string") return key;
      if (!options) return raw;
      let text = raw;
      for (const [k, v] of Object.entries(options)) {
        text = text.replace(new RegExp(`{{\\s*${k}\\s*}}`, "g"), String(v));
      }
      return text;
    },
    i18n: {
      language: currentLang.lang,
      changeLanguage: (next: string) => {
        currentLang.lang = next;
      },
    },
  }),
}));

describe("CombatStatusAnnouncer", () => {
  beforeEach(() => {
    currentLang.lang = "fr";
    cleanup();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  const baseTurnInfo: CurrentTurnInfo = {
    playerId: "p1",
    playerName: "Player 1",
    isHuman: true,
    playerColor: VGA_PALETTE.RED,
    angle: 45,
    power: 50,
    currentWeapon: "MISSILE",
    inventory: { MISSILE: -1 },
    turn: 1,
    isInputLocked: false,
    tanksAreFalling: false,
  };

  it("mounts polite status live region with initially empty content before updates", () => {
    const { container } = render(
      <CombatStatusAnnouncer round={1} turnInfo={null} wind={0} />
    );

    const region = screen.getByRole("status");
    expect(region).toBeDefined();
    expect(region.getAttribute("aria-live")).toBe("polite");
    expect(region.className).toContain("visually-hidden");
    expect(region.textContent).toBe("");
    expect(container.firstChild).toBe(region);
  });

  it("announces round turn, player name and calm wind on initial mount with data", async () => {
    render(<CombatStatusAnnouncer round={1} turnInfo={baseTurnInfo} wind={0} />);

    const region = screen.getByRole("status");
    // After effect commit
    expect(region.textContent).toBe("Tour 1, Player 1, vent calme");
  });

  it("announces east and west wind matching WindBanner format in FR and EN", () => {
    // East wind (positive force)
    const { rerender } = render(
      <CombatStatusAnnouncer round={1} turnInfo={baseTurnInfo} wind={25} />
    );
    const region = screen.getByRole("status");
    expect(region.textContent).toBe("Tour 1, Player 1, vent EST force 25");

    // West wind (negative force)
    rerender(
      <CombatStatusAnnouncer
        round={1}
        turnInfo={{ ...baseTurnInfo, turn: 2, playerId: "p2", playerName: "CPU 2" }}
        wind={-15}
      />
    );
    expect(region.textContent).toBe("Tour 2, CPU 2, vent OUEST force 15");

    // Switch to English
    currentLang.lang = "en";
    rerender(
      <CombatStatusAnnouncer
        round={1}
        turnInfo={{ ...baseTurnInfo, turn: 3, playerId: "p1" }}
        wind={30}
      />
    );
    expect(region.textContent).toBe("Turn 3, Player 1, wind EAST strength 30");

    rerender(
      <CombatStatusAnnouncer
        round={1}
        turnInfo={{ ...baseTurnInfo, turn: 4, playerId: "p2", playerName: "CPU 2" }}
        wind={0}
      />
    );
    expect(region.textContent).toBe("Turn 4, CPU 2, calm wind");
  });

  it("announces new turn when players share the same name but have different playerId", () => {
    const p1: CurrentTurnInfo = { ...baseTurnInfo, playerId: "id-1", playerName: "Ace", turn: 1 };
    const p2: CurrentTurnInfo = { ...baseTurnInfo, playerId: "id-2", playerName: "Ace", turn: 2 };

    const { rerender } = render(<CombatStatusAnnouncer round={1} turnInfo={p1} wind={0} />);
    const region = screen.getByRole("status");
    expect(region.textContent).toBe("Tour 1, Ace, vent calme");

    rerender(<CombatStatusAnnouncer round={1} turnInfo={p2} wind={0} />);
    expect(region.textContent).toBe("Tour 2, Ace, vent calme");
  });

  it("does not re-announce on aiming, power, weapon or inventory changes", () => {
    const { rerender } = render(<CombatStatusAnnouncer round={1} turnInfo={baseTurnInfo} wind={0} />);
    const region = screen.getByRole("status");
    expect(region.textContent).toBe("Tour 1, Player 1, vent calme");

    const record: MutationRecord[] = [];
    const observer = new MutationObserver((mutations) => record.push(...mutations));
    observer.observe(region, { characterData: true, childList: true, subtree: true });

    // Aim change
    rerender(<CombatStatusAnnouncer round={1} turnInfo={{ ...baseTurnInfo, angle: 46 }} wind={0} />);
    // Power change
    rerender(<CombatStatusAnnouncer round={1} turnInfo={{ ...baseTurnInfo, angle: 46, power: 55 }} wind={0} />);
    // Weapon change
    rerender(
      <CombatStatusAnnouncer
        round={1}
        turnInfo={{ ...baseTurnInfo, angle: 46, power: 55, currentWeapon: "GRENADE", inventory: { MISSILE: -1, GRENADE: 3 } }}
        wind={0}
      />
    );

    const mutations = [...record, ...observer.takeRecords()];
    expect(mutations).toHaveLength(0);
    expect(region.textContent).toBe("Tour 1, Player 1, vent calme");
    observer.disconnect();
  });

  it("handles remote opponent turn: aims with locked inputs without resolving, announces once on fire, and ignores HUD updates during shot", () => {
    const opponentAiming: CurrentTurnInfo = {
      ...baseTurnInfo,
      playerId: "p2",
      playerName: "Opponent",
      turn: 2,
      isInputLocked: true,
      isResolving: false,
      tanksAreFalling: false,
    };

    const { rerender } = render(
      <CombatStatusAnnouncer round={1} turnInfo={opponentAiming} wind={0} />
    );
    const region = screen.getByRole("status");
    expect(region.textContent).toBe("Tour 2, Opponent, vent calme");

    const record: MutationRecord[] = [];
    const observer = new MutationObserver((mutations) => record.push(...mutations));
    observer.observe(region, { characterData: true, childList: true, subtree: true });

    // 1. L'adversaire vise. Les commandes locales sont verrouillées et le HUD reçoit une mise à jour.
    rerender(
      <CombatStatusAnnouncer
        round={1}
        turnInfo={{ ...opponentAiming, angle: 60, power: 75 }}
        wind={0}
      />
    );
    // Aucune annonce de résolution ne doit être émise
    expect([...record, ...observer.takeRecords()]).toHaveLength(0);
    expect(region.textContent).toBe("Tour 2, Opponent, vent calme");

    // 2. L'adversaire tire. L'annonce de résolution doit être émise une seule fois.
    rerender(
      <CombatStatusAnnouncer
        round={1}
        turnInfo={{ ...opponentAiming, angle: 60, power: 75, isResolving: true }}
        wind={0}
      />
    );
    expect(region.textContent).toBe("Résolution du tir");
    const resolvingRecords = [...record, ...observer.takeRecords()];
    expect(resolvingRecords.length).toBeGreaterThan(0);

    // 3. Le HUD reçoit une autre mise à jour pendant le même tir. L'annonce ne doit pas se répéter.
    record.length = 0;
    rerender(
      <CombatStatusAnnouncer
        round={1}
        turnInfo={{ ...opponentAiming, angle: 60, power: 75, isResolving: true }}
        wind={5}
      />
    );
    expect([...record, ...observer.takeRecords()]).toHaveLength(0);
    expect(region.textContent).toBe("Résolution du tir");

    observer.disconnect();
  });

  it("tracks sequential shot resolution, falling tanks, and avoids second resolving announcement when falling settles with input locked", () => {
    const { rerender } = render(<CombatStatusAnnouncer round={1} turnInfo={baseTurnInfo} wind={0} />);
    const region = screen.getByRole("status");
    expect(region.textContent).toBe("Tour 1, Player 1, vent calme");

    // Shot fired -> enters resolution
    rerender(
      <CombatStatusAnnouncer
        round={1}
        turnInfo={{ ...baseTurnInfo, isInputLocked: true, tanksAreFalling: false }}
        wind={0}
      />
    );
    expect(region.textContent).toBe("Résolution du tir");

    // Craters formed -> tanks are falling
    rerender(
      <CombatStatusAnnouncer
        round={1}
        turnInfo={{ ...baseTurnInfo, isInputLocked: true, tanksAreFalling: true }}
        wind={0}
      />
    );
    expect(region.textContent).toBe("Chute des tanks");

    // Tanks settle, but input lock is still active before turn advancement
    rerender(
      <CombatStatusAnnouncer
        round={1}
        turnInfo={{ ...baseTurnInfo, isInputLocked: true, tanksAreFalling: false }}
        wind={0}
      />
    );
    // Must NOT re-announce resolution
    expect(region.textContent).toBe("Chute des tanks");

    // Turn advances to player 2
    rerender(
      <CombatStatusAnnouncer
        round={1}
        turnInfo={{
          ...baseTurnInfo,
          playerId: "p2",
          playerName: "Player 2",
          turn: 2,
          isInputLocked: false,
          tanksAreFalling: false,
        }}
        wind={0}
      />
    );
    expect(region.textContent).toBe("Tour 2, Player 2, vent calme");
  });

  it("prioritizes falling announcement when falling and resolution become visible simultaneously", () => {
    const { rerender } = render(<CombatStatusAnnouncer round={1} turnInfo={baseTurnInfo} wind={0} />);
    const region = screen.getByRole("status");
    expect(region.textContent).toBe("Tour 1, Player 1, vent calme");

    // Simultaneous resolution + falling
    rerender(
      <CombatStatusAnnouncer
        round={1}
        turnInfo={{ ...baseTurnInfo, isInputLocked: true, tanksAreFalling: true }}
        wind={0}
      />
    );
    expect(region.textContent).toBe("Chute des tanks");

    // Falling settles, input still locked
    rerender(
      <CombatStatusAnnouncer
        round={1}
        turnInfo={{ ...baseTurnInfo, isInputLocked: true, tanksAreFalling: false }}
        wind={0}
      />
    );
    // Stays at falling announcement, does not announce resolution afterwards
    expect(region.textContent).toBe("Chute des tanks");
  });

  it("announces round 2 turn 1 even if player and turn number are identical to round 1", () => {
    const { rerender } = render(<CombatStatusAnnouncer round={1} turnInfo={baseTurnInfo} wind={0} />);
    const region = screen.getByRole("status");
    expect(region.textContent).toBe("Tour 1, Player 1, vent calme");

    // Start round 2 with same player and turn 1
    rerender(<CombatStatusAnnouncer round={2} turnInfo={baseTurnInfo} wind={10} />);
    expect(region.textContent).toBe("Tour 1, Player 1, vent EST force 10");
  });

  it("captures orderly mutations via MutationObserver across turn lifecycle", async () => {
    const mutations: string[] = [];
    const { rerender } = render(<CombatStatusAnnouncer round={1} turnInfo={null} wind={0} />);
    const region = screen.getByRole("status");

    const observer = new MutationObserver(() => {
      mutations.push(region.textContent ?? "");
    });
    observer.observe(region, { characterData: true, childList: true, subtree: true });

    // 1. Initial turn announcement
    act(() => {
      rerender(<CombatStatusAnnouncer round={1} turnInfo={baseTurnInfo} wind={0} />);
    });
    await Promise.resolve();

    // 2. Shot resolution
    act(() => {
      rerender(
        <CombatStatusAnnouncer
          round={1}
          turnInfo={{ ...baseTurnInfo, isInputLocked: true, tanksAreFalling: false }}
          wind={0}
        />
      );
    });
    await Promise.resolve();

    // 3. Falling
    act(() => {
      rerender(
        <CombatStatusAnnouncer
          round={1}
          turnInfo={{ ...baseTurnInfo, isInputLocked: true, tanksAreFalling: true }}
          wind={0}
        />
      );
    });
    await Promise.resolve();

    // 4. Settling (no change)
    act(() => {
      rerender(
        <CombatStatusAnnouncer
          round={1}
          turnInfo={{ ...baseTurnInfo, isInputLocked: true, tanksAreFalling: false }}
          wind={0}
        />
      );
    });
    await Promise.resolve();

    // 5. Next turn
    act(() => {
      rerender(
        <CombatStatusAnnouncer
          round={1}
          turnInfo={{ ...baseTurnInfo, playerId: "p2", playerName: "CPU 2", turn: 2, isInputLocked: false }}
          wind={0}
        />
      );
    });
    await Promise.resolve();

    expect(mutations).toEqual([
      "Tour 1, Player 1, vent calme",
      "Résolution du tir",
      "Chute des tanks",
      "Tour 2, CPU 2, vent calme",
    ]);

    observer.disconnect();
  });

  it("clears message and produces no ghost announcements when turnInfo becomes null", () => {
    const { rerender } = render(<CombatStatusAnnouncer round={1} turnInfo={baseTurnInfo} wind={0} />);
    const region = screen.getByRole("status");
    expect(region.textContent).toBe("Tour 1, Player 1, vent calme");

    rerender(<CombatStatusAnnouncer round={1} turnInfo={null} wind={0} />);
    expect(region.textContent).toBe("");
  });
});

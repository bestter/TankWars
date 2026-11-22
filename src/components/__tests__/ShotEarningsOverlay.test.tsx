// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  EARNINGS_DISPLAY_MS,
  ShotEarningsOverlay,
} from "../ShotEarningsOverlay";

describe("ShotEarningsOverlay", () => {
  const onDismiss = vi.fn();
  const overlay = {
    shotId: 8,
    displayedAt: 1_000,
    awards: [
      { playerId: "p1", playerName: "ALICE", color: "#55FFFF", amount: 100, x: 180, y: 320 },
      { playerId: "p2", playerName: "BOB", color: "#FFFF55", amount: 25, x: 620, y: 295 },
    ],
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("affiche simultanément les bénéficiaires avec leur couleur", () => {
    render(
      <ShotEarningsOverlay
        overlay={overlay}
        onDismiss={onDismiss}
      />,
    );
    const aliceReward = screen.getByText("+100$");
    expect(aliceReward.style.color).toBe("rgb(85, 255, 255)");
    expect(aliceReward.style.left).toBe("22.5%");
    expect(aliceReward.style.top).toBe("58.75%");
    const bobReward = screen.getByText("+25$");
    expect(bobReward.style.color).toBe("rgb(255, 255, 85)");
    expect(bobReward.style.left).toBe("77.5%");
    expect(bobReward.style.top).toBe("53.5417%");
  });

  it("projette et borne les coordonnées extrêmes en pourcentages sur la scène 800×480", () => {
    render(
      <ShotEarningsOverlay
        overlay={{
          shotId: 9,
          displayedAt: 1_000,
          awards: [
            { playerId: "left", playerName: "LEFT", color: "#55FFFF", amount: 10, x: 0, y: 10 },
            { playerId: "right", playerName: "RIGHT", color: "#FFFF55", amount: 20, x: 800, y: 480 },
            { playerId: "out", playerName: "OUT", color: "#FF5555", amount: 30, x: 950, y: 600 },
          ],
        }}
        onDismiss={onDismiss}
      />,
    );
    const leftReward = screen.getByText("+10$");
    expect(leftReward.style.left).toBe("8%");
    expect(leftReward.style.top).toBe("10%");
    const rightReward = screen.getByText("+20$");
    expect(rightReward.style.left).toBe("92%");
    expect(rightReward.style.top).toBe("92.0833%");
    const outReward = screen.getByText("+30$");
    expect(outReward.style.left).toBe("92%");
    expect(outReward.style.top).toBe("95%");
  });

  it("ferme automatiquement après trois secondes", () => {
    render(
      <ShotEarningsOverlay
        overlay={overlay}
        onDismiss={onDismiss}
      />,
    );
    act(() => vi.advanceTimersByTime(EARNINGS_DISPLAY_MS));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("ne bloque pas les interactions et nettoie sa minuterie au démontage", () => {
    const rendered = render(
      <ShotEarningsOverlay
        overlay={overlay}
        onDismiss={onDismiss}
      />,
    );
    expect(screen.getByRole("status").hasAttribute("data-blocking")).toBe(false);
    rendered.unmount();
    act(() => vi.runAllTimers());
    expect(onDismiss).not.toHaveBeenCalled();
  });
});

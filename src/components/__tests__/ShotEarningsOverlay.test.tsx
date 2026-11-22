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
    expect(aliceReward.style.left).toBe("");
    expect(aliceReward.style.top).toBe("");
    expect(aliceReward.style.getPropertyValue("--award-x")).toBe("0.225");
    expect(aliceReward.style.getPropertyValue("--award-y")).toBe("0.5875");
    const bobReward = screen.getByText("+25$");
    expect(bobReward.style.color).toBe("rgb(255, 255, 85)");
    expect(bobReward.style.getPropertyValue("--award-x")).toBe("0.775");
    expect(bobReward.style.getPropertyValue("--award-y")).toBe("0.535417");
  });

  it("normalise les coordonnées dans [0, 1] sans borner prématurément les bords à 8 %", () => {
    render(
      <ShotEarningsOverlay
        overlay={{
          shotId: 9,
          displayedAt: 1_000,
          awards: [
            { playerId: "near-left", playerName: "L", color: "#55FFFF", amount: 100, x: 60, y: 320 },
            { playerId: "near-right", playerName: "R", color: "#FFFF55", amount: 100, x: 740, y: 320 },
            { playerId: "left", playerName: "LEFT", color: "#55FFFF", amount: 10, x: 0, y: 10 },
            { playerId: "right", playerName: "RIGHT", color: "#FFFF55", amount: 20, x: 800, y: 480 },
            { playerId: "out", playerName: "OUT", color: "#FF5555", amount: 30, x: 950, y: 600 },
            { playerId: "nan", playerName: "NAN", color: "#FFFFFF", amount: 40, x: Number.NaN, y: Number.POSITIVE_INFINITY },
          ],
        }}
        onDismiss={onDismiss}
      />,
    );
    const nearLeft = screen.getAllByText("+100$")[0];
    expect(nearLeft.style.left).toBe("");
    expect(nearLeft.style.getPropertyValue("--award-x")).toBe("0.075");
    expect(nearLeft.style.getPropertyValue("--award-y")).toBe("0.5875");
    const nearRight = screen.getAllByText("+100$")[1];
    expect(nearRight.style.getPropertyValue("--award-x")).toBe("0.925");
    expect(nearRight.style.getPropertyValue("--award-y")).toBe("0.5875");
    const leftReward = screen.getByText("+10$");
    expect(leftReward.style.getPropertyValue("--award-x")).toBe("0");
    expect(leftReward.style.getPropertyValue("--award-y")).toBe("0");
    const rightReward = screen.getByText("+20$");
    expect(rightReward.style.getPropertyValue("--award-x")).toBe("1");
    expect(rightReward.style.getPropertyValue("--award-y")).toBe("0.920833");
    const outReward = screen.getByText("+30$");
    expect(outReward.style.getPropertyValue("--award-x")).toBe("1");
    expect(outReward.style.getPropertyValue("--award-y")).toBe("1");
    const nanReward = screen.getByText("+40$");
    expect(nanReward.style.getPropertyValue("--award-x")).toBe("0.5");
    expect(nanReward.style.getPropertyValue("--award-y")).toBe("0.5");
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

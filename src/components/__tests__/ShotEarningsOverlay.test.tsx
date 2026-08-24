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
    expect(aliceReward.style.left).toBe("180px");
    expect(aliceReward.style.top).toBe("282px");
    expect(screen.getByText("+25$").style.color).toBe("rgb(255, 255, 85)");
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

// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { VGA_PALETTE } from "../../types/game";
import { GameLogo } from "../GameLogo";
import { GAME_LOGO, GAME_LOGO_COMPACT } from "../gameLogoArt";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

describe("GameLogo", () => {
  beforeEach(() => {
    cleanup();
  });

  it("garde le titre accessible dans le h1 et masque le dessin", () => {
    render(<GameLogo />);

    const title = screen.getByRole("heading", { level: 1, name: "main_title" });
    expect(title.textContent).toContain("main_title");
    const graphic = title.querySelector("svg");
    expect(graphic?.getAttribute("aria-hidden")).toBe("true");
    expect(graphic?.getAttribute("width")).toBe(String(GAME_LOGO.width));
    expect(graphic?.getAttribute("height")).toBe(String(GAME_LOGO.height));
  });

  it("réduit le même dessin dans le lobby", () => {
    render(<GameLogo compact />);

    const graphic = screen.getByRole("heading", { level: 1 }).querySelector("svg");
    expect(graphic?.getAttribute("width")).toBe(String(GAME_LOGO_COMPACT.width));
    expect(graphic?.getAttribute("height")).toBe(String(GAME_LOGO_COMPACT.height));
    expect(Number(GAME_LOGO_COMPACT.width)).toBeLessThan(GAME_LOGO.width);
  });

  it("reste dans la palette VGA 16 couleurs", () => {
    const allowed = new Set<string>(Object.values(VGA_PALETTE));
    for (const path of GAME_LOGO.paths) {
      expect(allowed.has(path.color)).toBe(true);
    }
  });
});

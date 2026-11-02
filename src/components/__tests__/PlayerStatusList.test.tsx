// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, isInaccessible, render, screen } from "@testing-library/react";
import i18next from "i18next";
import { I18nextProvider } from "react-i18next";
import fr from "../../locales/fr.json";
import en from "../../locales/en.json";
import { PlayerStatusList } from "../PlayerStatusList";
import type { PlayerStatusCard } from "../playerStatus";
import type { AiProfile } from "../../types/player";

afterEach(cleanup);

function card(overrides: Partial<PlayerStatusCard> = {}): PlayerStatusCard {
  return {
    id: "alice",
    name: "Alice",
    color: "#ff5555",
    isHuman: true,
    aiProfile: "v4-smart",
    health: 72.5,
    maxHealth: 100,
    shield: 0,
    maxShield: 40,
    inventory: { NUKE: 1, GRENADE: 0, THERMONUCLEAR: 2, BULLET: -1, MISSILE: 9 },
    ...overrides,
  };
}

const roster = [
  card(),
  card({
    id: "bob",
    name: "Bob",
    color: "#55ff55",
    isHuman: false,
    aiProfile: "v2-heuristic",
    health: 0.04,
    shield: 40,
    maxShield: 40.25,
    inventory: { DRILLER: 3 },
  }),
];

async function show(language: string, gameMode: "local" | "online" = "local", players = roster) {
  const i18n = i18next.createInstance();
  await i18n.init({
    lng: language,
    resources: { fr: { translation: fr }, en: { translation: en } },
    interpolation: { escapeValue: false },
  });
  render(
    <I18nextProvider i18n={i18n}>
      <PlayerStatusList players={players} currentPlayerId="alice" gameMode={gameMode} />
    </I18nextProvider>,
  );
}

describe("PlayerStatusList", () => {
  it.each([
    ["fr", "État des tanks", "TOI", "PV 72,5 / 100", "Bouclier 0,0 / 40", "PV 0,1 / 100", "Bouclier 40,0 / 40,3", "HUMAIN", "IA OK"],
    ["en", "Tank status", "YOU", "HP 72.5 / 100", "Shield 0.0 / 40", "HP 0.1 / 100", "Shield 40.0 / 40.3", "HUMAN", "OK AI"],
  ] as const)("renders health, shield and profiles in %s", async (language, title, you, aliceHealth, aliceShield, bobHealth, bobShield, human, ok) => {
    await show(language);
    expect(screen.getByRole("region", { name: title })).toBeDefined();
    expect(screen.getByText(you)).toBeDefined();
    expect(screen.getByText("Alice").textContent).toBe("Alice");
    expect(screen.getByText(aliceHealth)).toBeDefined();
    expect(screen.getByText(aliceShield)).toBeDefined();
    expect(screen.getByText(bobHealth)).toBeDefined();
    expect(screen.getByText(bobShield)).toBeDefined();
    expect(screen.getByText(human)).toBeDefined();
    expect(screen.getByText(ok)).toBeDefined();
    expect(document.querySelectorAll(".player-status-swatch")[0]?.getAttribute("aria-hidden")).toBe("true");
  });

  it("lists missile as unlimited and hides empty stocks, including nukes only when positive", async () => {
    await show("fr");
    const chips = Array.from(document.querySelectorAll(".player-status-chip [aria-hidden='true']")).map((node) => node.textContent);
    expect(chips).toEqual(["MIS:∞", "NUK:1", "THM:2", "MIS:∞", "DRL:3"]);
    expect(isInaccessible(screen.getByText("Mini-Nuke 1"))).toBe(false);
    const missiles = screen.getAllByText("Missile ∞");
    expect(missiles).toHaveLength(2);
    expect(missiles.some(isInaccessible)).toBe(false);
    expect(screen.queryByText(/Grenade/)).toBeNull();
    expect(screen.queryByText(/BLT/)).toBeNull();
  });

  it("keeps a disabled lock button on local opponents only", async () => {
    await show("fr");
    const lock = screen.getByRole("button", { name: "Verrouiller Bob" });
    expect(lock.hasAttribute("disabled")).toBe(true);
    expect(lock.getAttribute("type")).toBe("button");
    expect(lock.getAttribute("data-lock-target")).toBe("bob");
    expect(lock.textContent).toBe("Verrouiller la cible");
    expect(screen.queryByRole("button", { name: "Verrouiller Alice" })).toBeNull();
    fireEvent.click(lock);
    expect(lock.hasAttribute("disabled")).toBe(true);
  });

  it("omits the lock button online", async () => {
    await show("en", "online");
    expect(screen.queryByRole("button", { name: /Lock/ })).toBeNull();
    expect(screen.getByText("YOU")).toBeDefined();
  });

  it("uses the simple label for every known fallback and ignores a human profile", async () => {
    const profiles: Array<AiProfile | null> = ["v1-random", "v3-sniper", "v4-smart", null];
    await show("fr", "local", [
      card({ id: "human", name: "Ada", isHuman: true, aiProfile: "v4-smart" }),
      ...profiles.map((aiProfile, index) => card({
        id: `ai-${index}`,
        name: `Bot ${index}`,
        isHuman: false,
        aiProfile,
      })),
    ]);
    expect(screen.getAllByText("HUMAIN")).toHaveLength(1);
    expect(screen.getAllByText("IA SIMPLE")).toHaveLength(2);
    expect(screen.getByText("IA SNIPER")).toBeDefined();
    expect(screen.getByText("IA EXPERT")).toBeDefined();
  });
});

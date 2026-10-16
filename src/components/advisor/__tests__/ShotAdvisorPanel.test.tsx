// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import i18next from "i18next";
import { I18nextProvider } from "react-i18next";
import fr from "../../../locales/fr.json";
import en from "../../../locales/en.json";
import { ShotAdvisorPanel } from "../ShotAdvisorPanel";
import type { AdvisorView } from "../AdvisorController";

afterEach(cleanup);
async function show(view: AdvisorView, language = "fr") {
  const i18n = i18next.createInstance();
  await i18n.init({ lng: language, resources: { fr: { translation: fr }, en: { translation: en } }, interpolation: { escapeValue: false } });
  const handlers = { request: vi.fn(), apply: vi.fn(), setObjective: vi.fn() };
  render(<I18nextProvider i18n={i18n}><ShotAdvisorPanel view={view} {...handlers} /></I18nextProvider>);
  return handlers;
}
describe("advisor accessible production UI", () => {
  it.each(["fr", "en"])("renders translated predictions and explicit shooter death in %s", async (language) => {
    const resources = language === "fr" ? fr : en;
    await show({ playerId: "self", objective: "OPTIMISER_PROFIT", status: "result", names: { enemy: "Bob" },
      result: { objective: "OPTIMISER_PROFIT", command: { angle: 60.4, power: 50, weaponId: "NUKE" },
        targetIds: ["enemy"], gain: 1000, cost: 900, profit: 100, shooterDestroyed: true,
        consequences: [{ playerId: "enemy", health: 10, shield: 20, destroyed: true }] } }, language);
    expect(screen.getByText(resources.advisor_shooter_destroyed)).toBeDefined();
    expect(screen.getByText(/60.4/)).toBeDefined(); expect(screen.getByText(/Bob :|Bob:/)).toBeDefined();
    expect(screen.getByText(/1000/)).toBeDefined(); expect(screen.getByText(resources.advisor_prediction)).toBeDefined();
    expect(screen.getByRole("button", { name: resources.advisor_apply }).hasAttribute("disabled")).toBe(false);
  });

  it("keeps objective selection and keyboard access during calculation, disables only new requests/apply", async () => {
    const handlers = await show({ playerId: "self", objective: "SURVIE", status: "calculating" });
    expect(screen.getByRole("button", { name: fr.advisor_title }).hasAttribute("disabled")).toBe(true);
    const user = userEvent.setup();
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole("combobox"));
    await user.selectOptions(screen.getByRole("combobox"), "OPTIMISER_PROFIT");
    expect(handlers.setObjective).toHaveBeenCalledWith("OPTIMISER_PROFIT");
    expect(handlers.request).not.toHaveBeenCalled(); expect(handlers.apply).not.toHaveBeenCalled();
  });

  it("touch/click requests and application are separate actions", async () => {
    const handlers = await show({ playerId: "self", objective: "SURVIE", status: "idle" });
    fireEvent.click(screen.getByRole("button", { name: fr.advisor_title }));
    expect(handlers.request).toHaveBeenCalledOnce(); expect(handlers.apply).not.toHaveBeenCalled();
  });

  it.each(["empty", "error", "expired"] as const)("shows understandable %s state without DEV traces", async (status) => {
    await show({ playerId: "self", objective: "SURVIE", status });
    expect(screen.getByText(fr[`advisor_${status}`])).toBeDefined();
  });

  it("does not render without an eligible human", async () => {
    await show({ objective: "SURVIE", status: "idle" });
    expect(screen.queryByRole("button", { name: fr.advisor_title })).toBeNull();
  });
});

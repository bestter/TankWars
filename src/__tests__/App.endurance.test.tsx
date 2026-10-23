// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import App from "../App";

vi.hoisted(() => { vi.stubEnv("MODE", "endurance"); });
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key, i18n: { language: "fr", changeLanguage: vi.fn() } }) }));
vi.mock("../components/SEO", () => ({ SEO: () => null }));
vi.mock("../components/GameCanvas", () => ({ GameCanvas: () => null }));
vi.mock("../components/MainMenu", () => ({
  MainMenu: ({ onEndurance }: { onEndurance?: () => void }) => onEndurance ? <button onClick={onEndurance}>endurance_title</button> : null,
}));
vi.mock("../components/endurance/EnduranceScreen", () => ({
  EnduranceScreen: ({ onExit }: { onExit: () => void }) => <button onClick={onExit}>endurance_config</button>,
}));

afterEach(() => { cleanup(); vi.unstubAllEnvs(); });

it("opens and exits endurance in the explicitly enabled test build", async () => {
  render(<App />);
  fireEvent.click(screen.getByRole("button", { name: "endurance_title" }));
  fireEvent.click(await screen.findByRole("button", { name: "endurance_config" }));
  expect(screen.getByRole("button", { name: "endurance_title" })).toBeDefined();
});

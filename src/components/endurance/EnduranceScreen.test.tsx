import reference from "../../../Scripts/endurance/scenarios/issue-361-rock-cliff.json";
// @vitest-environment jsdom
import { Blob as NodeBlob } from "node:buffer";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EnduranceScreen } from "./EnduranceScreen";
import { EnduranceSession } from "../../game/endurance/session";
import { IndexedEnduranceStorage } from "../../game/endurance/storage";
import { fixture } from "../../game/endurance/__tests__/helpers";
import fr from "../../locales/fr.json";
import en from "../../locales/en.json";

const language = vi.hoisted(() => ({ value: "fr" }));
const exports = vi.hoisted(() => ({ manifests: [] as Array<{ journal: { complete: boolean }; session: { id: string } }> }));
vi.mock("../../game/endurance/bundle/browserDisk", async () => {
  const { MemoryDisk } = await import("../../game/endurance/__tests__/bundleMemory");
  const { readJson } = await import("../../game/endurance/bundle/io");
  return { BrowserDisk: { create: async () => {
    const disk = new MemoryDisk();
    return Object.assign(disk, { dispose: async () => {}, download: async () => {
      exports.manifests.push(await readJson(disk, "manifest.json") as typeof exports.manifests[number]);
      blobs.push(new NodeBlob([disk.files.get("bundle.zip")!]));
    } });
  } } };
});
vi.mock("react-i18next", () => ({ useTranslation: () => ({ i18n: { language: language.value },
  t: (key: string, params?: Record<string, unknown>) => {
    const dict = (language.value === "fr" ? fr : en) as unknown as Record<string, string>;
    let text = dict[key] ?? key;
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        text = text.replace(new RegExp(`{{${k}}}`, "g"), String(v));
      }
    }
    return text;
  } }) }));
vi.mock("../GameCanvas", () => ({ GameCanvas: () => null }));
let blobs: NodeBlob[] = [];
beforeEach(() => {
  blobs = [];
  exports.manifests = [];
  vi.stubEnv("MODE", "endurance"); vi.stubGlobal("indexedDB", new IDBFactory()); vi.stubGlobal("IDBKeyRange", IDBKeyRange);
  vi.stubGlobal("Blob", NodeBlob);
  vi.stubGlobal("URL", { createObjectURL: (blob: NodeBlob) => { blobs.push(blob); return "blob:test"; }, revokeObjectURL: vi.fn() });
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
describe("JSONL and native exports through the interface (combat replaced by a fixture)", () => {
  it.each([7000, 14000, 28000, 29000])("preserves an exact %i ms duration entered in minutes", async durationMs => {
    language.value = "fr";
    render(<EnduranceScreen onExit={vi.fn()} />);
    const minutes = screen.getByLabelText(fr.endurance_minutes);
    // Match Driver.configure: fractional minutes are enabled for short runs.
    minutes.setAttribute("step", "any");
    fireEvent.change(minutes, { target: { value: String(durationMs / 60000) } });
    fireEvent.click(screen.getByRole("button", { name: fr.endurance_start }));
    const stop = await screen.findByRole("button", { name: fr.endurance_stop });
    fireEvent.click(stop);
    await waitFor(() => expect((screen.getByRole("button", { name: fr.btn_menu }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: /^JSON$/ }));
    await waitFor(() => expect(blobs).toHaveLength(1));
    expect(JSON.parse(await blobs[0].text())).toMatchObject({ session: { config: { maxDurationMs: durationMs } } });
  });

  it.each(["fr", "en"])("exports a stopped journal and global shots archive through the %s interface", async locale => {
    language.value = locale;
    const dict = locale === "fr" ? fr : en;
    render(<EnduranceScreen onExit={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: dict.endurance_start }));
    const stop = await screen.findByRole("button", { name: dict.endurance_stop });
    await waitFor(() => expect(window.__tankwarsEnduranceTest).toBeDefined());
    fireEvent.click(stop);
    await waitFor(() => expect((screen.getByRole("button", { name: dict.btn_menu }) as HTMLButtonElement).disabled).toBe(false));

    // Test JSONL export
    fireEvent.click(screen.getByRole("button", { name: /^JSONL$/ }));
    await waitFor(() => expect(blobs).toHaveLength(1));
    expect(exports.manifests.at(-1)?.journal.complete).toBe(true);
    expect(new Uint8Array(await blobs[0].arrayBuffer()).slice(0, 4)).toEqual(new Uint8Array([80, 75, 3, 4]));

    // Test Global Shots Export from DiagnosticPanel
    blobs = [];
    const exportShotsBtn = screen.getByRole("button", { name: dict.diagnostics_export });
    fireEvent.click(exportShotsBtn);
    await waitFor(() => expect(blobs).toHaveLength(1));
    expect(exports.manifests.at(-1)?.session.id).toBeDefined();
  });

  it.each(["fr", "en"])("exports recovered session shots and jsonl without filter confusion in %s", async locale => {
    language.value = locale;
    const dict = locale === "fr" ? fr : en;
    const storage = new IndexedEnduranceStorage(); const f = fixture();
    const run = new EnduranceSession(f.config, storage, undefined, "test-build");
    await run.start();
    await run.stop("manual");
    await run.close();

    render(<EnduranceScreen onExit={vi.fn()} />);

    // Recovered shots export button
    const shotsBtn = await screen.findByRole("button", { name: dict.diagnostics_export });
    blobs = [];
    fireEvent.click(shotsBtn);
    await waitFor(() => expect(blobs).toHaveLength(1));
    expect(exports.manifests.at(-1)?.session.id).toBe(run.session.id);

    // Recovered jsonl export button
    blobs = [];
    fireEvent.click(screen.getByRole("button", { name: /^JSONL$/ }));
    await waitFor(() => expect(blobs).toHaveLength(1));
    expect(exports.manifests.at(-1)?.journal.complete).toBe(true);

    storage.close();
  });

  it("marks recovered running checkpoints incomplete without mounting combat", async () => {
    language.value = "fr";
    const storage = new IndexedEnduranceStorage(); const f = fixture();
    await storage.save({ session: f.run.session, block: null });
    await storage.appendJournal([], { schemaVersion: 1, sessionId: f.run.session.id, emitted: 0, persisted: 0, complete: true, error: null });
    render(<EnduranceScreen onExit={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: /^JSONL$/ }));
    await waitFor(() => expect(blobs).toHaveLength(1));
    expect(exports.manifests.at(-1)?.journal.complete).toBe(false);
    expect(window.__tankwarsEnduranceTest).toBeUndefined(); storage.close();
  });

  it("configures freeWeapons when the checkbox is checked in endurance screen", async () => {
    language.value = "fr";
    render(<EnduranceScreen onExit={vi.fn()} />);

    const checkbox = screen.getByRole("checkbox", { name: /Mode armes gratuites/i }) as HTMLInputElement;
    expect(checkbox.checked).toBe(false);

    fireEvent.click(checkbox);
    expect(checkbox.checked).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: fr.endurance_start }));
    const stop = await screen.findByRole("button", { name: fr.endurance_stop });
    await waitFor(() => expect(window.__tankwarsEnduranceTest).toBeDefined());

    const page = await window.__tankwarsEnduranceTest!.readJournalText(0, 10);
    const rows = page.text ? page.text.trim().split("\n").map(l => JSON.parse(l) as { event: { kind: string; metadata?: unknown } }) : [];
    const sessionStart = rows.find(e => e.event.kind === "session-start");
    expect(
      sessionStart?.event.kind === "session-start" &&
        (sessionStart.event.metadata as { config: { freeWeapons?: boolean } }).config.freeWeapons,
    ).toBe(true);

    fireEvent.click(stop);
  });
});

// File.text is supplied explicitly because jsdom's File does not implement the browser API.
it.each(["fr", "en"])("imports, rejects replacement, removes and restores generated mode (%s)", async locale => {
  language.value = locale; const dict = locale === "fr" ? fr : en;
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(new Proxy({}, { get: () => () => undefined }) as CanvasRenderingContext2D);
  render(<EnduranceScreen onExit={vi.fn()} />);
  const count = screen.getByLabelText(dict.num_players) as HTMLSelectElement;
  const start = screen.getByRole("button", { name: dict.endurance_start }) as HTMLButtonElement;
  const upload = (text: string) => fireEvent.change(screen.getByTestId("endurance-scenario-input"), { target: { files: [{ text: async () => text }] } });
  expect(count.disabled).toBe(false);
  upload(JSON.stringify(reference));
  await screen.findByTestId("endurance-scenario-preview");
  expect(count.value).toBe("2"); expect(count.disabled).toBe(true);
  const profile = screen.getByLabelText(dict.endurance_profile.replace("{{number}}", "2")) as HTMLSelectElement;
  fireEvent.change(profile, { target: { value: "v4-smart" } }); expect(profile.value).toBe("v4-smart");
  upload('{"schemaVersion":');
  await waitFor(() => expect(screen.getByRole("alert").textContent).toContain(dict.endurance_scenario_invalid));
  expect(start.disabled).toBe(true); expect(screen.queryByTestId("endurance-scenario-preview")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: dict.endurance_scenario_remove }));
  expect(start.disabled).toBe(false); expect(count.disabled).toBe(false); expect(count.value).toBe("4");
  upload(JSON.stringify(reference)); await screen.findByTestId("endurance-scenario-preview");
  fireEvent.click(start); const stop = await screen.findByRole("button", { name: dict.endurance_stop }); fireEvent.click(stop);
  await waitFor(() => expect((screen.getByRole("button", { name: dict.btn_menu }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByRole("button", { name: /^JSON$/ })); await waitFor(() => expect(blobs).toHaveLength(1));
  const exported = JSON.parse(await blobs[0].text());
  expect(exported.session.config.scenario).toEqual(reference);
  expect(exported.session.config.players[1]).toMatchObject({ aiProfile: "v4-smart", tank: { position: { x: 695.675, y: 339 } } });
});

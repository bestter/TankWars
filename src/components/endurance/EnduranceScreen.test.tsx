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
  vi.stubEnv("MODE", "endurance"); vi.stubGlobal("indexedDB", new IDBFactory()); vi.stubGlobal("IDBKeyRange", IDBKeyRange);
  vi.stubGlobal("Blob", NodeBlob);
  vi.stubGlobal("URL", { createObjectURL: (blob: NodeBlob) => { blobs.push(blob); return "blob:test"; }, revokeObjectURL: vi.fn() });
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
describe("JSONL and native exports through the interface (combat replaced by a fixture)", () => {
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
    const rows = (await blobs[0].text()).trim().split("\n").map(line => JSON.parse(line) as { sequence?: number; kind?: string });
    expect(rows[0]).toMatchObject({ kind: "journal-status", status: { complete: true } });
    expect(rows.slice(1).map(r => r.sequence)).toEqual(rows.slice(1).map((_r, i) => i + 1));

    // Test Global Shots Export from DiagnosticPanel
    blobs = [];
    const exportShotsBtn = screen.getByRole("button", { name: dict.diagnostics_export });
    fireEvent.click(exportShotsBtn);
    await waitFor(() => expect(blobs).toHaveLength(1));
    const archive = JSON.parse(await blobs[0].text()) as { sessionId: string; records: unknown[]; filter?: unknown };
    expect(archive.sessionId).toBeDefined();
    expect(archive.filter).toBeUndefined(); // Global, unfiltered archive
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
    const archive = JSON.parse(await blobs[0].text()) as { sessionId: string; records: unknown[]; filter?: unknown };
    expect(archive.sessionId).toBe(run.session.id);
    expect(archive.filter).toBeUndefined();

    // Recovered jsonl export button
    blobs = [];
    fireEvent.click(screen.getByRole("button", { name: /^JSONL$/ }));
    await waitFor(() => expect(blobs).toHaveLength(1));
    const firstLine = (await blobs[0].text()).trim().split("\n")[0];
    const jsonlStatus = JSON.parse(firstLine) as { status: { complete: boolean } };
    expect(jsonlStatus.status.complete).toBe(true);

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
    expect(JSON.parse(await blobs[0].text())).toMatchObject({ status: { complete: false } });
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

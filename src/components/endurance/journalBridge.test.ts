import { afterEach, describe, expect, it, vi } from "vitest";
import { installJournalBridge } from "./journalBridge";
import { fixture } from "../../game/endurance/__tests__/helpers";

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
describe("local test-build journal bridge", () => {
  it("exposes the frozen stop measurement without extending the bridge API", async () => {
    vi.stubEnv("MODE", "endurance"); vi.stubGlobal("window", {});
    const f = fixture(); await f.run.start();
    const remove = installJournalBridge(f.run);
    expect(window.__tankwarsEnduranceTest!.readArchiveMetrics().stoppedAtDurationMs).toBeNull();
    f.advance(123); await f.run.stop(); f.advance(456);
    expect(window.__tankwarsEnduranceTest!.readArchiveMetrics().stoppedAtDurationMs).toBe(123);
    remove();
  });
  it("is absent in public builds", () => {
    vi.stubEnv("MODE", "production"); vi.stubGlobal("window", {});
    installJournalBridge(fixture().run);
    expect(window.__tankwarsEnduranceTest).toBeUndefined();
  });
  it("exposes new methods, omits retired methods, delegates bounded reads and protects a newer StrictMode installation from old cleanup", async () => {
    vi.stubEnv("MODE", "endurance"); vi.stubGlobal("window", {});
    const run = fixture().run;
    const read = vi.spyOn(run, "readJournalText").mockResolvedValue({
      status: null, firstSequence: null, lastSequence: null, count: 0, bytes: 0, text: "",
    });
    const old = installJournalBridge(run), current = installJournalBridge(run);
    old();
    const bridge = window.__tankwarsEnduranceTest;
    expect(bridge).toBeDefined();
    expect(bridge).toHaveProperty("readJournalText");
    expect(bridge).toHaveProperty("readArchiveMetrics");
    expect((bridge as unknown as { readJournalPage?: unknown }).readJournalPage).toBeUndefined();
    expect((bridge as unknown as { readArchive?: unknown }).readArchive).toBeUndefined();
    await bridge!.readJournalText(256, 128);
    expect(read).toHaveBeenCalledWith(256, 128);
    expect(bridge!.readArchiveMetrics()).toBeDefined();
    current();
    expect(window.__tankwarsEnduranceTest).toBeUndefined();
  });
});

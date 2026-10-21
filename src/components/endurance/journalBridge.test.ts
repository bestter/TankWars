import { afterEach, describe, expect, it, vi } from "vitest";
import { installJournalBridge } from "./journalBridge";
import { fixture } from "../../game/endurance/__tests__/helpers";

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
describe("local test-build journal bridge", () => {
  it("is absent in public builds", () => {
    vi.stubEnv("MODE", "production"); vi.stubGlobal("window", {});
    installJournalBridge(fixture().run);
    expect(window.__tankwarsEnduranceTest).toBeUndefined();
  });
  it("delegates bounded reads and protects a newer StrictMode installation from old cleanup", async () => {
    vi.stubEnv("MODE", "endurance"); vi.stubGlobal("window", {});
    const run = fixture().run; const read = vi.spyOn(run, "journalPage").mockResolvedValue({ status: null, entries: [] });
    const old = installJournalBridge(run), current = installJournalBridge(run);
    old(); expect(window.__tankwarsEnduranceTest).toBeDefined();
    await window.__tankwarsEnduranceTest!.readJournalPage(256, 128);
    expect(read).toHaveBeenCalledWith(256, 128);
    current(); expect(window.__tankwarsEnduranceTest).toBeUndefined();
  });
});

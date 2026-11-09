// @vitest-environment jsdom
import { render, cleanup } from "@testing-library/react";
import { useLayoutEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BundleExport } from "../BundleExport";
import { downloadEnduranceBundle } from "../journalBridge";
import type { BundleSource } from "../../../game/endurance/bundle/build";
import { MemoryDisk } from "../../../game/endurance/__tests__/bundleMemory";
import { fixture } from "../../../game/endurance/__tests__/helpers";

let createdDisk: MemoryDisk | null = null;

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ i18n: { language: "fr" }, t: (k: string) => k }),
}));

vi.mock("../../../game/endurance/bundle/browserDisk", () => ({
  BrowserDisk: {
    create: async () => {
      const disk = new MemoryDisk();
      createdDisk = disk;
      return Object.assign(disk, {
        dispose: async () => {},
        download: async () => {},
      });
    },
  },
}));

beforeEach(() => {
  createdDisk = null;
  vi.stubGlobal("window", globalThis);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  delete window.__tankwarsEnduranceBundle;
});

function fakeSource(): BundleSource {
  const f = fixture();
  return {
    session: f.run.session,
    status: {
      schemaVersion: 1,
      sessionId: f.run.session.id,
      persisted: 0,
      emitted: 0,
      complete: true,
      error: null,
    },
    journal: async () => [],
    terrain: async () => { throw new Error("no terrain"); },
    collection: async () => [],
  };
}

describe("BundleExport concurrency and zip cleanup", () => {
  it("allows an export as soon as the recovered controls are committed", async () => {
    let download: Promise<void> | undefined;
    function RecoveredControls() {
      useLayoutEffect(() => {
        download = downloadEnduranceBundle();
        // Attach a handler before React flushes passive effects.
        void download.catch(() => {});
      }, []);
      return <BundleExport source={async () => fakeSource()} />;
    }
    render(<RecoveredControls />);
    expect(download).toBeDefined();
    await expect(download).resolves.toBeUndefined();
    expect(createdDisk).not.toBeNull();
  });

  it("rejects concurrent leased prepare calls with EXPORT_BUSY", async () => {
    render(<BundleExport source={async () => fakeSource()} />);
    const bridge = window.__tankwarsEnduranceBundle!;
    expect(bridge).toBeDefined();

    const p1 = bridge.prepare(undefined, true);
    await expect(bridge.prepare(undefined, true)).rejects.toThrow("EXPORT_BUSY");
    await p1;
    bridge.unlock();
  });

  it("removes bundle.zip on download completion", async () => {
    render(<BundleExport source={async () => fakeSource()} />);
    const bridge = window.__tankwarsEnduranceBundle!;
    expect(bridge).toBeDefined();

    await bridge.download();
    expect(createdDisk).not.toBeNull();
    expect(createdDisk!.files.has("bundle.zip")).toBe(false);
  });
});

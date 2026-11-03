// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import DiagnosticPanel from "./DiagnosticPanel";
import { ShotRecorder } from "../../game/diagnostics/archive";
import { filterArchive } from "../../game/diagnostics/export";
import { makePlayer, makeTank } from "../../game/__tests__/helpers";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
describe("diagnostic archive controls", () => {
  it("highlights partial and in-progress metadata, then clears notices after resolution", async () => {
    const source = { read: vi.fn(async () => null), capture: vi.fn(), list: vi.fn(async () => ({
      rows: [{ key: "shot", label: "Alice", status: "interrupted" }], total: 1, firstSequence: 1, lastSequence: 10, evicted: 0,
      captureInProgress: true, incomplete: true,
    })) };
    render(<DiagnosticPanel source={source} />); fireEvent.click(screen.getByText("diagnostics_title"));
    fireEvent.click(screen.getByRole("button", { name: "diagnostics_refresh" }));
    expect(await screen.findByText("diagnostics_capture_in_progress")).toBeTruthy();
    expect(screen.getByText("diagnostics_archive_incomplete")).toBeTruthy();
    expect(screen.getByText("diagnostics_shot_interrupted").className).toContain("diagnostic-status-warning");
    source.list.mockResolvedValue({ rows: [{ key: "shot", label: "Alice", status: "settled" }], total: 1, firstSequence: 1, lastSequence: 11,
      evicted: 0, captureInProgress: false, incomplete: false });
    fireEvent.click(screen.getByRole("button", { name: "diagnostics_refresh" }));
    await waitFor(() => expect(screen.queryByText("diagnostics_capture_in_progress")).toBeNull());
    expect(screen.queryByText("diagnostics_archive_incomplete")).toBeNull();
    expect(screen.getByText("diagnostics_shot_settled").className).not.toContain("diagnostic-status-warning");
    expect(source.read).not.toHaveBeenCalled();
  });
  it("shows the current in-progress capture even before any shot exists", async () => {
    const recorder = new ShotRecorder("current");
    recorder.record({ kind: "current", snapshot: {
      state: { players: [makePlayer({ id: "a" }), makePlayer({ id: "b" })], phase: "COMBAT", currentPlayerIndex: 0, turn: 1, windForce: 0, gravity: 260 },
      motion: { velocities: [], fallenDistances: [], isVoidFall: [], fallAttributions: [] }, width: 2, height: 480,
      heights: [300, 300], materials: ["DIRT", "DIRT"], localMatch: true, freeWeapons: false, initialPlayerCount: 2,
      projectiles: [], step: 1, inProgress: true,
    } });
    const source = { read: vi.fn(async () => recorder.export()), capture: vi.fn() };
    render(<DiagnosticPanel source={source} />); fireEvent.click(screen.getByText("diagnostics_title"));
    fireEvent.click(screen.getByRole("button", { name: "diagnostics_capture" }));
    expect(await screen.findByText("diagnostics_capture_in_progress")).toBeTruthy();
    expect(screen.queryAllByRole("listitem")).toHaveLength(0); expect(source.capture).toHaveBeenCalledOnce();
  });
  it("uses the bounded endurance index instead of loading the full archive to list shots", async () => {
    const source = { read: vi.fn(async () => null), capture: vi.fn(), list: vi.fn(async () => ({
      rows: [{ key: "shot", label: "Alice", status: "settled" }], total: 1, firstSequence: 1, lastSequence: 1000, evicted: 0,
    })) };
    render(<DiagnosticPanel source={source} />); fireEvent.click(screen.getByText("diagnostics_title"));
    fireEvent.click(screen.getByRole("button", { name: "diagnostics_refresh" }));
    await waitFor(() => expect(screen.getAllByRole("listitem")).toHaveLength(1));
    expect(source.list).toHaveBeenCalledWith("", 0); expect(source.read).not.toHaveBeenCalled();
  });
  it("paginates, filters by shot identity, exports the selected dependency chain and flags a situation", async () => {
    const recorder = new ShotRecorder("session");
    const players = [makePlayer({ id: "a", name: "Alice" }), makePlayer({ id: "b", tank: makeTank("tb", 450, 300) })];
    for (let turn = 1; turn <= 41; turn++) {
      recorder.record({ kind: "combat", event: { kind: "turn", turn, playerId: "a", roundNumber: 1 } });
      recorder.record({ kind: "pre-shot", shot: { shotId: turn, playerId: "a", command: { weaponId: "MISSILE", angle: 45, power: 50 }, origin: { x: 120, y: 300 }, isFirstShotOfRound: turn === 1 },
        snapshot: { state: { players, phase: "COMBAT", currentPlayerIndex: 0, turn, roundNumber: 1, windForce: 0, gravity: 260 },
          motion: { velocities: [], fallenDistances: [], isVoidFall: [], fallAttributions: [] }, width: 800, height: 480,
          heights: Array<number>(800).fill(300), materials: Array(800).fill("DIRT"), localMatch: true, freeWeapons: false, initialPlayerCount: 2, projectiles: [], step: turn, inProgress: false } });
    }
    const source = { read: vi.fn(async (filter?: import("../../game/diagnostics/export").ArchiveFilter) => filterArchive(recorder.export(), filter)), capture: vi.fn(), mark: vi.fn() };
    vi.stubGlobal("URL", { createObjectURL: vi.fn(() => "blob:test"), revokeObjectURL: vi.fn() });
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    render(<DiagnosticPanel source={source} />);
    fireEvent.click(screen.getByText("diagnostics_title"));
    fireEvent.click(screen.getByRole("button", { name: "diagnostics_refresh" }));
    await waitFor(() => expect(screen.getAllByRole("listitem")).toHaveLength(20));
    fireEvent.click(screen.getByRole("button", { name: "diagnostics_next" }));
    await waitFor(() => expect(screen.getAllByRole("listitem")[0].textContent).toContain("session:1:21"));
    fireEvent.change(screen.getByLabelText("diagnostics_filter"), { target: { value: "session:1:41" } });
    fireEvent.click(screen.getByRole("button", { name: "diagnostics_refresh" }));
    await waitFor(() => expect(screen.getAllByRole("listitem")).toHaveLength(1));
    fireEvent.click(screen.getByRole("button", { name: "diagnostics_export_shot" }));
    await waitFor(() => expect(source.read).toHaveBeenLastCalledWith({ shotKey: "session:1:41" }));
    await waitFor(() => expect((screen.getByRole("button", { name: "diagnostics_mark" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "diagnostics_mark" })); expect(source.mark).toHaveBeenCalledOnce();
  });
  it("shows failed reads instead of silently losing the export", async () => {
    const source = { read: async () => { throw new Error("INDEXEDDB_READ_FAILED"); }, capture: vi.fn() };
    render(<DiagnosticPanel source={source} />); fireEvent.click(screen.getByText("diagnostics_title"));
    fireEvent.click(screen.getByRole("button", { name: "diagnostics_export" }));
    expect((await screen.findByRole("alert")).textContent).toContain("INDEXEDDB_READ_FAILED");
  });
});

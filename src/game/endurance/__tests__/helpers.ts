import { vi } from "vitest";
import { createLocalPlayers } from "../../../components/localPlayers";
import { VGA_PALETTE } from "../../../types/game";
import { defaultConfig } from "../config";
import { EnduranceSession, type EnduranceClock, type EnduranceHost } from "../session";
import type { Checkpoint, EnduranceStorage } from "../storage";
import type { BlockRecord, EnduranceExport, Incident, SessionRecord } from "../types";

export class MemoryStorage implements EnduranceStorage {
  writes: Checkpoint[] = [];
  async save(c: Checkpoint) { this.writes.push(structuredClone(c)); }
  async latest() { return this.writes.at(-1)?.session ?? null; }
  async exportSession(session: SessionRecord): Promise<EnduranceExport> {
    const blocks = new Map<string, BlockRecord>();
    const rounds = new Map<string, NonNullable<Checkpoint["round"]>>();
    const incidents = new Map<string, Incident>();
    for (const c of this.writes) {
      if (c.block) blocks.set(c.block.id, c.block);
      if (c.round) rounds.set(c.round.id, c.round);
      if (c.incident) incidents.set(c.incident.id, c.incident);
    }
    return { schemaVersion: 1, session: structuredClone(session), blocks: [...blocks.values()], rounds: [...rounds.values()], incidents: [...incidents.values()],
      diagnostics: { evaluatedCommand: "unavailable", perturbations: "unavailable", deterministicReplay: false, combatResume: false } };
  }
  close() {}
}
export function fixture() {
  const players = createLocalPlayers([
    { name: "Simple", isHuman: false, aiProfile: "v1-random", color: VGA_PALETTE.BLUE },
    { name: "Expert", isHuman: false, aiProfile: "v4-smart", color: VGA_PALETTE.RED },
  ]);
  const config = { ...defaultConfig(players), maxBlocks: 2 };
  let now = 0, ids = 0;
  const clock: EnduranceClock = { now: () => now, date: () => new Date(100000 + now).toISOString(), id: () => `id-${++ids}`, seed: () => 4294967295 };
  const storage = new MemoryStorage();
  const run = new EnduranceSession(config, storage, clock, "test-build");
  const host: EnduranceHost = { stop: vi.fn(), context: () => ({ players, heights: Array<number>(800).fill(300), materials: Array<string>(800).fill("DIRT"), phase: "COMBAT" }) };
  return { config, players, run, storage, host, advance: (ms: number) => { now += ms; } };
}

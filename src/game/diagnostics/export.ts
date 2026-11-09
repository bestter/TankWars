import type { EnduranceStorage } from "../endurance/storage";
import type { ShotArchive } from "./types";
import { emptyArchive, sealArchive, recordTerrainId } from "./archive";
import { validateArchive } from "./validate";

export interface ArchiveFilter { shotKey?: string; from?: number; to?: number; incidents?: boolean }
export function filterArchive(archive: ShotArchive, filter: ArchiveFilter = {}): ShotArchive {
  if ([filter.from, filter.to].some(n => n !== undefined && (!Number.isSafeInteger(n) || n < 1)) ||
    (filter.from !== undefined && filter.to !== undefined && filter.from > filter.to)) throw new Error("INVALID_ARCHIVE_RANGE");
  let records = archive.records;
  const selected = new Set<string>();
  const contextKey = (r: typeof records[number]) => `${r.blockId}/${r.round}/${r.turn}`;
  const incidentContexts = new Set<string>();
  if (filter.shotKey) selected.add(filter.shotKey);
  if (filter.incidents) for (const r of records) {
    if ((r.input.kind === "combat" && ["failure", "recovery", "shot-refused"].includes(r.input.event.kind)) ||
      (r.input.kind === "boundary" && ["incident", "manual-incident"].includes(r.input.status))) {
      incidentContexts.add(contextKey(r)); if (r.shotKey) selected.add(r.shotKey);
    }
  }
  if (filter.from !== undefined || filter.to !== undefined) for (const r of records) {
    if (r.shotKey && r.sequence >= (filter.from ?? 0) && r.sequence <= (filter.to ?? Infinity)) selected.add(r.shotKey);
  }
  if (filter.shotKey || filter.incidents || filter.from !== undefined || filter.to !== undefined) {
    const decisions = new Set(records.filter(r => r.shotKey && selected.has(r.shotKey)).map(r => r.decisionId).filter(Boolean));
    const contexts = new Set([...incidentContexts, ...records.filter(r => r.shotKey && selected.has(r.shotKey)).map(contextKey)]);
    records = records.filter(r => (r.shotKey && selected.has(r.shotKey)) || (r.decisionId && decisions.has(r.decisionId)) ||
      contexts.has(contextKey(r)) ||
      (!r.shotKey && (filter.from !== undefined || filter.to !== undefined) &&
        r.sequence >= (filter.from ?? 0) && r.sequence <= (filter.to ?? Infinity)));
  }
  const ids = new Set<string>();
  for (const record of records) {
    const id = recordTerrainId(record);
    if (id !== undefined) ids.add(id);
  }
  return sealArchive({ ...archive, records, firstSequence: records[0]?.sequence ?? 0, terrains: archive.terrains.filter(t => ids.has(t.id)) });
}

/** Freeze the confirmed upper sequence: later writes cannot enter this export. */
export async function exportStoredArchive(storage: EnduranceStorage, sessionId: string, build?: string, filter?: ArchiveFilter): Promise<ShotArchive> {
  const status = await storage.journalStatus?.(sessionId);
  if (!status || !storage.readArchive) throw new Error("ARCHIVE_CAPABILITY_UNAVAILABLE");
  const writes = await storage.readArchive(sessionId, status.persisted, filter);
  const terrains = new Map(writes.flatMap(w => w.terrains.map(t => [t.id, t] as const)));
  const records = writes.map(w => w.record);
  const source = records.find(r => r.input.kind === "boundary" && r.input.status === "archive-manifest")?.input;
  if (source?.kind !== "boundary" || typeof source.detail !== "object" || source.detail === null) throw new Error("ARCHIVE_CAPABILITY_UNAVAILABLE");
  const header = source.detail as Record<string, unknown>;
  if (typeof header.build !== "string" || typeof header.gameVersion !== "string" || typeof header.rules !== "string" || header.sessionId !== sessionId) throw new Error("INVALID_STORED_MANIFEST");
  return filterArchive(validateArchive(sealArchive({ ...emptyArchive(sessionId, build), build: header.build, gameVersion: header.gameVersion, rules: header.rules,
    records, terrains: [...terrains.values()],
    firstSequence: records[0]?.sequence ?? 0, lastSequence: records.at(-1)?.sequence ?? 0,
    complete: status.complete, error: status.error })), filter);
}

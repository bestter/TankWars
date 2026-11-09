import { scenarioProvenance } from "../scenario";
import { emptyArchive, RULES_ID } from "../../diagnostics/archive";
import { validateArchive } from "../../diagnostics/validate";
import type { ArchiveRecord, TerrainRecord } from "../../diagnostics/types";
import type { JournalEntry, JournalStatus } from "../journal";
import type { SessionRecord } from "../types";
import { formatJournalTextPage } from "../journalJsonl";
import type { EnduranceStorage } from "../storage";
import { Catalogue, exportOptions, PartWriter, publishDerived, type BundleManifest, type ExportOptions, type Location } from "./format";
import { identity, jsonBytes, one, sha256, type BundleDisk } from "./io";
import { indexCollection, indexEntry, renderReport } from "./report";

export interface BundleSource {
  session: SessionRecord; status: JournalStatus;
  journal(after: number): Promise<JournalEntry[]>;
  terrain(id: string): Promise<TerrainRecord>;
  collection(name: "blocks" | "rounds" | "incidents", after?: IDBValidKey): Promise<Array<{ key: IDBValidKey; value: unknown; capturedAtSequence?: number | null }>>;
  pending?: readonly JournalEntry[];
}
export function storedBundleSource(storage: EnduranceStorage, session: SessionRecord, status: JournalStatus): BundleSource {
  if (!storage.readJournal || !storage.readTerrain || !storage.collectionPage) throw new Error("BUNDLE_PAGINATION_UNAVAILABLE");
  return { session: structuredClone(session), status: { ...status },
    journal: after => storage.readJournal!(session.id, after, 256),
    terrain: id => storage.readTerrain!(id), collection: (name, after) => storage.collectionPage!(name, session.id, after) };
}
export interface BundleProgress { stage: string; sequence: number; upper: number }
async function rememberUnconfirmedTerrain(disk: BundleDisk, terrain: TerrainRecord): Promise<void> {
  const previous = await disk.get("unconfirmed-terrains", terrain.id);
  if (previous !== undefined && JSON.stringify(previous) !== JSON.stringify(terrain)) throw new Error("TERRAIN_ID_COLLISION");
  await disk.put("unconfirmed-terrains", terrain.id, terrain);
}
export async function buildBundle(source: BundleSource, disk: BundleDisk, input: Partial<ExportOptions> = {},
  signal?: AbortSignal, progress: (value: BundleProgress) => void = () => {}): Promise<BundleManifest> {
  const options = exportOptions(input), limit = options.partSizeMiB * 1048576;
  const catalogue = new Catalogue(disk, limit), publish = catalogue.add.bind(catalogue);
  const previous = await disk.get("export-state", "manifest") as BundleManifest | undefined;
  const generationNumber = Number(await disk.get("export-state", "generation") ?? 0) + 1;
  await disk.put("export-state", "generation", generationNumber);
  if (previous && (previous.session.id !== source.session.id || JSON.stringify(previous.options) !== JSON.stringify(options) || previous.journal.persisted > source.status.persisted)) throw new Error("EXPORT_GENERATION_MISMATCH");
  await catalogue.restore(previous?.catalogue ?? null, previous?.catalogueSha256 ?? null);
  const journal = new PartWriter(disk, "journal", limit, publish);
  const captures = new PartWriter(disk, "captures", limit, publish);
  const terrains = new PartWriter(disk, "terrains", limit, publish);
  const manifest: BundleManifest = { format: "tankwars-endurance-bundle", schemaVersion: 1, terrain: scenarioProvenance(source.session.config.scenario),
    generation: `${source.status.persisted}-${generationNumber}-${Date.now()}`, createdAt: new Date().toISOString(),
    session: structuredClone(source.session), journal: { ...source.status }, options, rules: RULES_ID,
    catalogue: null, catalogueSha256: null, index: previous?.index ?? "index/root.json", complete: source.status.error === null,
    reportComplete: false, reportError: null, captureFirst: previous?.captureFirst ?? 0, captureLast: previous?.captureLast ?? 0,
    summaryAtSequence: source.status.persisted, unconfirmed: Boolean(source.pending?.length),
    derivedCatalogue: previous?.derivedCatalogue ?? null, derivedCatalogueSha256: previous?.derivedCatalogueSha256 ?? null,
    indexBoundary: previous?.indexBoundary ?? null };
  const addTerrain = async (id: string, supplied?: TerrainRecord) => {
    const prior = await disk.get("terrains", id);
    if (prior !== undefined && !supplied) return;
    const value = supplied ?? await source.terrain(id);
    if (prior !== undefined) {
      if (supplied && JSON.stringify(await disk.get("terrain-content", id)) !== JSON.stringify(value)) throw new Error("TERRAIN_ID_COLLISION");
      return;
    }
    validateArchive({ ...emptyArchive(source.session.id, source.session.build), terrains: [value] });
    const location = await terrains.append(jsonBytes(value));
    await disk.put("terrains", id, location); await disk.put("terrain-content", id, value);
    const path = `index/terrains/${await identity(id)}.json`, bytes = jsonBytes({ id, location });
    await disk.write(path, one(bytes));
    await publish({ path, type: "terrain-index", order: 0, bytes: bytes.length, sha256: await sha256(bytes), count: 1,
      firstSequence: null, lastSequence: null, oversized: bytes.length > limit });
  };
  const scenario = source.session.config.scenario;
  // A failed first write leaves the initial terrain in the unconfirmed suffix only.
  const pendingScenario = scenario && source.pending?.some(entry => entry.sequence > source.status.persisted &&
    entry.event.kind === "archive" && entry.event.write.terrains.some(terrain => terrain.id === scenario.terrainId));
  if (scenario && !pendingScenario) await addTerrain(scenario.terrainId);
  let after = previous?.journal.persisted ?? 0;
  while (after < source.status.persisted) {
    signal?.throwIfAborted();
    // A fixed confirmed upper boundary excludes later writes without pausing combat.
    const rows = await source.journal(after);
    formatJournalTextPage(rows, source.session.id, after, 256, source.status);
    for (const entry of rows) {
      if (entry.sequence > source.status.persisted) break;
      const location = await journal.append(jsonBytes(entry), entry.sequence);
      let capture: { record: ArchiveRecord; location: Location } | undefined;
      if (entry.event.kind === "archive") {
        const { record, terrains: supplied } = entry.event.write;
        if (record.sequence !== manifest.captureLast + 1) throw new Error("CAPTURE_SEQUENCE_GAP");
        manifest.captureFirst ||= record.sequence; manifest.captureLast = record.sequence;
        // Terrain deduplication and byte offsets share one ordered writer.
        // react-doctor-disable-next-line react-doctor/async-await-in-loop
        for (const terrain of supplied) await addTerrain(terrain.id, terrain);
        if ("snapshot" in record.input) await addTerrain(record.input.snapshot.terrainId);
        const dependencies = "snapshot" in record.input ? [await disk.get("terrain-content", record.input.snapshot.terrainId) as TerrainRecord] : [];
        validateArchive({ ...emptyArchive(source.session.id, source.session.build), gameVersion: source.session.gameVersion,
          records: [record], terrains: dependencies, firstSequence: record.sequence, lastSequence: record.sequence });
        if (record.input.kind === "pre-shot") {
          if (record.shotKey === null || await disk.get("recorded-shots", record.shotKey)) throw new Error("DUPLICATE_SHOT_KEY");
          await disk.put("recorded-shots", record.shotKey, true);
        }
        capture = { record, location: await captures.append(jsonBytes({ journalSequence: entry.sequence, record }), entry.sequence) };
        await disk.put("captures", String(record.sequence).padStart(16, "0"), { ...capture, journalSequence: entry.sequence });
      }
      await indexEntry(disk, entry, location, capture, options.slowDecisionMs);
      after = entry.sequence;
    }
    progress({ stage: "data", sequence: after, upper: source.status.persisted });
  }
  await journal.flush(); await captures.flush(); await terrains.flush();
  for (const name of ["blocks", "rounds", "incidents"] as const) {
    const writer = new PartWriter(disk, `session/${name}`, limit, publish);
    let cursor: IDBValidKey | undefined;
    for (;;) {
      signal?.throwIfAborted();
      const rows = await source.collection(name, cursor); if (!rows.length) break;
      for (const row of rows) {
        const key = typeof row.value === "object" && row.value !== null && "id" in row.value ? String(row.value.id) : JSON.stringify(row.key);
        // Each row advances the same bounded writer and its publication cursor.
        // react-doctor-disable-next-line react-doctor/async-await-in-loop
        const signature = await identity(JSON.stringify(row.value));
        if (await disk.get(`collection-${name}`, key) === signature) continue;
        if (row.capturedAtSequence !== undefined && row.capturedAtSequence !== null && row.capturedAtSequence > source.status.persisted) continue;
        const location = await writer.append(jsonBytes({ capturedAtSequence: row.capturedAtSequence ?? null, exportedAtSequence: source.status.persisted, record: row.value }));
        await indexCollection(disk, name, row.value, location, row.capturedAtSequence ?? null);
        await disk.put(`collection-${name}`, key, signature);
      }
      cursor = rows[rows.length - 1].key;
    }
    await writer.flush();
  }
  const sessionWriter = new PartWriter(disk, "session/metadata", limit, publish);
  await sessionWriter.append(jsonBytes({ session: source.session, journal: source.status, capturedAtSequence: source.status.persisted }));
  await sessionWriter.flush();
  if (source.pending?.length) {
    const pending = new PartWriter(disk, "unconfirmed/journal", limit, publish);
    for (const entry of source.pending) {
      if (entry.sequence <= source.status.persisted) continue;
      // Preserve the unconfirmed native suffix's sequence and byte offsets.
      // react-doctor-disable-next-line react-doctor/async-await-in-loop
      await pending.append(jsonBytes(entry), entry.sequence);
      if (entry.event.kind === "archive") for (const terrain of entry.event.write.terrains) {
        // The dependency map must finish each update before the next suffix record.
        // react-doctor-disable-next-line react-doctor/async-await-in-loop
        await rememberUnconfirmedTerrain(disk, terrain);
      }
    }
    await pending.flush();
    const dependencies = new PartWriter(disk, "unconfirmed/terrains", limit, publish);
    for await (const row of disk.scan("unconfirmed-terrains")) await dependencies.append(jsonBytes(row.value));
    await dependencies.flush();
  }
  await catalogue.flush(); manifest.catalogue = catalogue.head;
  manifest.catalogueSha256 = catalogue.headSha256;
  // Data manifest remains usable even when derived views cannot be generated.
  await disk.write("manifest.json", one(jsonBytes(manifest)));
  try {
    progress({ stage: "report", sequence: after, upper: source.status.persisted });
    const prefix = `derived/${manifest.generation}/`;
    await renderReport(disk, manifest, signal, prefix);
    await disk.write("index.html", one(new TextEncoder().encode(`<!doctype html><meta charset="utf-8"><title>Endurance</title><a href="${prefix}index.html">Rapport hors ligne / Offline report</a><p>Borne / Boundary: ${manifest.journal.persisted}</p><p>Signé / Signed : Codex — GPT-6</p>`)));
    await publishDerived(disk, manifest, prefix);
    manifest.index = `${prefix}index/root.json`;
    manifest.reportComplete = true;
  } catch (error) {
    if (signal?.aborted) throw error;
    manifest.reportError = `rapport incomplet / report incomplete: ${String(error)}`;
    console.warn("[Endurance] Derived report failed", error);
    try {
      const link = previous?.index ? `<a href="${previous.index.replace("index/root.json", "index.html")}">Dernier rapport / Last report (${previous.indexBoundary})</a>` : "";
      await disk.write("index.html", one(new TextEncoder().encode(`<!doctype html><meta charset="utf-8"><title>Rapport incomplet / Incomplete report</title><h1>Rapport incomplet / Incomplete report</h1><p>Données confirmées / Confirmed data: ${manifest.journal.persisted}</p>${link}<p>Régénération / Regeneration: node Scripts/endurance/build-report.mjs manifest.json --output new-folder</p><p>Signé / Signed : Codex — GPT-6</p>`)));
    } catch (warning) { console.warn("[Endurance] Incomplete report notice could not be written", warning); }
  }
  await disk.write("manifest.json", one(jsonBytes(manifest)));
  await disk.put("export-state", "manifest", manifest);
  if (manifest.reportComplete) {
    try {
      const prefix = `derived/${manifest.generation}/`, catalogPrefix = `catalog-reports/${manifest.generation}/`;
      for await (const row of disk.scan("files")) if ((row.key.startsWith("derived/") && !row.key.startsWith(prefix)) ||
        (row.key.startsWith("catalog-reports/") && !row.key.startsWith(catalogPrefix))) await disk.remove(row.key);
    } catch (error) { console.warn("[Endurance] Old derived generation cleanup failed", error); }
  }
  return manifest;
}

export async function shotIndexPath(key: string): Promise<string> { return `index/shots/${await identity(key)}.json`; }

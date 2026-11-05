import { emptyArchive, RULES_ID, sealArchive } from "../../diagnostics/archive";
import { validateArchive, object } from "../../diagnostics/validate";
import type { ArchiveRecord, ShotArchive, TerrainRecord } from "../../diagnostics/types";
import type { BundleManifest, CataloguePage, FileReference, Location } from "./format";
import { exportOptions } from "./format";
import { validateSessionRecord } from "../storage";
import { identity, jsonBytes, lines, readBytes, readJson, safePath, sha256, type BundleDisk } from "./io";

export async function readManifest(disk: BundleDisk): Promise<BundleManifest> {
  const value = await readJson(disk, "manifest.json");
  if (!object(value) || value.format !== "tankwars-endurance-bundle" || value.schemaVersion !== 1) throw new Error("UNSUPPORTED_BUNDLE_SCHEMA");
  if (value.rules !== RULES_ID || !object(value.session) || typeof value.session.id !== "string" ||
    typeof value.session.build !== "string" || typeof value.session.gameVersion !== "string" || !object(value.journal) ||
    value.journal.sessionId !== value.session.id || !Number.isSafeInteger(value.journal.persisted) || Number(value.journal.persisted) < 0 ||
    !object(value.options) || typeof value.complete !== "boolean" || typeof value.reportComplete !== "boolean" ||
    (value.catalogue !== null && typeof value.catalogue !== "string") || typeof value.index !== "string" ||
    !value.index.endsWith("index/root.json") || typeof value.generation !== "string" ||
    typeof value.journal.complete !== "boolean" || !(value.journal.error === null || typeof value.journal.error === "string") ||
    !Number.isSafeInteger(value.journal.emitted) || Number(value.journal.emitted) < Number(value.journal.persisted)) throw new Error("INVALID_BUNDLE_MANIFEST");
  validateSessionRecord(value.session); safePath(value.index);
  exportOptions(value.options);
  return value as unknown as BundleManifest;
}
export async function* catalogueFiles(disk: BundleDisk, manifest: BundleManifest): AsyncIterable<FileReference> {
  let path = manifest.catalogue, expectedHash = manifest.catalogueSha256, pages = 0;
  while (path) {
    safePath(path);
    if (await disk.get(`read-catalogue-${manifest.generation}`, path) !== undefined) throw new Error("CATALOGUE_CYCLE_OR_DUPLICATE");
    await disk.put(`read-catalogue-${manifest.generation}`, path, ++pages);
    const raw = await readBytes(disk, path);
    if (await sha256(raw) !== expectedHash) throw new Error("CATALOGUE_INTEGRITY_FAILED");
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw));
    if (!object(value) || !Array.isArray(value.files) || value.files.length > 256 ||
      (value.next !== null && typeof value.next !== "string")) throw new Error("INVALID_CATALOGUE");
    const page = value as unknown as CataloguePage;
    for (const file of page.files) {
      if (!object(file) || typeof file.path !== "string" || typeof file.sha256 !== "string" ||
        !Number.isSafeInteger(file.bytes) || file.bytes < 0 || !Number.isSafeInteger(file.count) || file.count < 0) throw new Error("INVALID_FILE_REFERENCE");
      safePath(file.path); yield file;
    }
    path = page.next;
    expectedHash = page.nextSha256;
  }
}
export async function loadCatalogue(disk: BundleDisk, manifest: BundleManifest): Promise<void> {
  // Persistent map, never a root list proportional to the session.
  if (await disk.get("read-state", manifest.generation)) return;
  for await (const file of catalogueFiles(disk, manifest)) {
    const prior = await disk.get("read-files", file.path);
    if (prior && JSON.stringify(prior) !== JSON.stringify(file)) throw new Error("BUNDLE_REFERENCE_CHANGED");
    await disk.put("read-files", file.path, file);
  }
  await disk.put("read-state", manifest.generation, true);
}
export async function verifyFile(disk: BundleDisk, path: string): Promise<void> {
  safePath(path);
  if (await disk.get("verified-files", path)) return;
  const reference = (await disk.get("read-files", path) ?? await disk.get("derived-files", path)) as FileReference | undefined;
  if (!reference) throw new Error("UNREFERENCED_BUNDLE_FILE");
  const bytes = await readBytes(disk, path);
  if (bytes.length !== reference.bytes || await sha256(bytes) !== reference.sha256) throw new Error("BUNDLE_FILE_INTEGRITY_FAILED");
  if (path.endsWith(".jsonl")) {
    let count = 0; for (const byte of bytes) if (byte === 10) count++;
    if (count !== reference.count || bytes.at(-1) !== 10) throw new Error("BUNDLE_RECORD_COUNT_MISMATCH");
  }
  await disk.put("verified-files", path, true);
}
async function locationJson(disk: BundleDisk, location: Location): Promise<unknown> {
  if (!object(location) || !Number.isSafeInteger(location.offset) || location.offset < 0 || !Number.isSafeInteger(location.length) || location.length <= 0) throw new Error("INVALID_BYTE_RANGE");
  await verifyFile(disk, location.path);
  const bytes = await readBytes(disk, location.path, location.offset, location.length);
  if (bytes.length !== location.length || bytes.at(-1) !== 10) throw new Error("INCOMPLETE_BYTE_RANGE");
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
}
async function terrain(disk: BundleDisk, id: string): Promise<TerrainRecord> {
  const path = `index/terrains/${await identity(id)}.json`;
  await verifyFile(disk, path);
  const ref = await readJson(disk, path);
  if (!object(ref) || ref.id !== id || !object(ref.location)) throw new Error("MISSING_TERRAIN_REFERENCE");
  const value = await locationJson(disk, ref.location as unknown as Location);
  if (!object(value) || value.id !== id) throw new Error("MISSING_TERRAIN_REFERENCE");
  return value as unknown as TerrainRecord;
}
function archiveHeader(manifest: BundleManifest): ShotArchive {
  return { ...emptyArchive(manifest.session.id, manifest.session.build), gameVersion: manifest.session.gameVersion,
    rules: manifest.rules, complete: manifest.journal.complete, error: manifest.journal.error };
}
export async function extractShot(disk: BundleDisk, key: string): Promise<ShotArchive> {
  const manifest = await readManifest(disk); await loadCatalogue(disk, manifest);
  if (manifest.derivedCatalogue) {
    const derivedManifest = { ...manifest, generation: `${manifest.generation}-derived`, catalogue: manifest.derivedCatalogue, catalogueSha256: manifest.derivedCatalogueSha256 };
    for await (const file of catalogueFiles(disk, derivedManifest)) await disk.put("derived-files", file.path, file);
  }
  const prefix = manifest.index.slice(0, -"index/root.json".length);
  let path: string | null = `${prefix}index/shots/${await identity(key)}.json`;
  const records: ArchiveRecord[] = [], terrains = new Map<string, TerrainRecord>();
  let previous = 0;
  while (path) {
    await verifyFile(disk, path);
    const page = await readJson(disk, path);
    if (!object(page) || page.shotKey !== key || !Array.isArray(page.refs) || page.refs.length > 256 ||
      (page.next !== null && typeof page.next !== "string")) throw new Error("INVALID_SHOT_INDEX");
    for (const ref of page.refs) {
      if (!object(ref) || !object(ref.location)) throw new Error("INVALID_CAPTURE_REFERENCE");
      // Validation advances a strict sequence and retains only this shot's context.
      // react-doctor-disable-next-line react-doctor/async-await-in-loop
      const value = await locationJson(disk, ref.location as unknown as Location);
      if (!object(value) || value.journalSequence !== ref.journalSequence || !object(value.record) || value.record.sequence !== ref.sequence || Number(value.record.sequence) <= previous) throw new Error("INVALID_CAPTURE_REFERENCE");
      const record = value.record as unknown as ArchiveRecord; previous = record.sequence;
      records.push(record);
      if ("snapshot" in record.input && !terrains.has(record.input.snapshot.terrainId)) terrains.set(record.input.snapshot.terrainId, await terrain(disk, record.input.snapshot.terrainId));
    }
    path = page.next ? prefix + String(page.next) : null;
  }
  if (!records.some(r => r.shotKey === key && r.input.kind === "pre-shot")) throw new Error("SHOT_NOT_FOUND");
  return validateArchive(sealArchive({ ...archiveHeader(manifest), records, terrains: [...terrains.values()],
    firstSequence: records[0]?.sequence ?? 0, lastSequence: records.at(-1)?.sequence ?? 0 }));
}
export async function validateBundle(disk: BundleDisk): Promise<BundleManifest> {
  const manifest = await readManifest(disk); await loadCatalogue(disk, manifest);
  for await (const row of disk.scan("read-files")) await verifyFile(disk, row.key);
  // Sequence ordering is global even when catalog pages are linked backwards.
  let journalSequence = 0, captureSequence = 0;
  for await (const row of disk.scan("read-files", "terrains/")) {
    for await (const line of lines(disk, row.key)) {
      const value: unknown = JSON.parse(new TextDecoder().decode(line.bytes));
      if (!object(value) || typeof value.id !== "string" || await disk.get("validated-terrains", value.id)) throw new Error("DUPLICATE_TERRAIN_ID");
      validateArchive({ ...archiveHeader(manifest), records: [], terrains: [value as unknown as TerrainRecord] });
      await disk.put("validated-terrains", value.id, { path: row.key, offset: line.offset, length: line.bytes.length });
    }
  }
  for await (const row of disk.scan("read-files", "journal/")) {
    for await (const line of lines(disk, row.key)) {
      const value: unknown = JSON.parse(new TextDecoder().decode(line.bytes));
      if (!object(value) || value.sessionId !== manifest.session.id || value.sequence !== ++journalSequence) throw new Error("JOURNAL_SEQUENCE_GAP");
      if (object(value.event) && value.event.kind === "archive" && object(value.event.write)) await disk.put("journal-captures", String(journalSequence), await sha256(jsonBytes(value.event.write.record)));
    }
  }
  if (journalSequence !== manifest.journal.persisted) throw new Error("JOURNAL_BOUNDARY_MISMATCH");
  for await (const row of disk.scan("read-files", "captures/")) {
    for await (const line of lines(disk, row.key)) {
      const value: unknown = JSON.parse(new TextDecoder().decode(line.bytes));
      if (!object(value) || !object(value.record) || value.record.sequence !== ++captureSequence) throw new Error("CAPTURE_SEQUENCE_GAP");
      const record = value.record as unknown as ArchiveRecord;
      if (await disk.get("journal-captures", String(value.journalSequence)) !== await sha256(jsonBytes(record))) throw new Error("CAPTURE_JOURNAL_MISMATCH");
      const dependencies = "snapshot" in record.input ? [await terrain(disk, record.input.snapshot.terrainId)] : [];
      validateArchive({ ...archiveHeader(manifest), records: [record], terrains: dependencies, firstSequence: record.sequence, lastSequence: record.sequence });
      if (record.input.kind === "pre-shot") {
        if (typeof record.shotKey !== "string" || await disk.get("validated-shots", record.shotKey)) throw new Error("DUPLICATE_SHOT_KEY");
        await disk.put("validated-shots", record.shotKey, true);
      }
    }
  }
  if (captureSequence !== manifest.captureLast) throw new Error("CAPTURE_BOUNDARY_MISMATCH");
  return manifest;
}

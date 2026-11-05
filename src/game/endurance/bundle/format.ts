import type { SessionRecord } from "../types";
import type { JournalStatus } from "../journal";
import { jsonBytes, one, readBytes, sha256, type BundleDisk } from "./io";

export interface ExportOptions { partSizeMiB: number; slowDecisionMs: number }
export const DEFAULT_EXPORT_OPTIONS: ExportOptions = { partSizeMiB: 20, slowDecisionMs: 1000 };
export function exportOptions(input: Partial<ExportOptions> = {}): ExportOptions {
  const options = { ...DEFAULT_EXPORT_OPTIONS, ...input };
  if (![options.partSizeMiB, options.slowDecisionMs, options.partSizeMiB * 1048576].every(n => Number.isSafeInteger(n) && n > 0)) throw new Error("INVALID_EXPORT_OPTIONS");
  return Object.freeze(options);
}
export interface FileReference {
  path: string; type: string; order: number; bytes: number; sha256: string; count: number;
  firstSequence: number | null; lastSequence: number | null; oversized: boolean;
}
export interface Location { path: string; offset: number; length: number }
export interface BundleManifest {
  format: "tankwars-endurance-bundle"; schemaVersion: 1; generation: string; createdAt: string;
  session: SessionRecord; journal: JournalStatus; options: ExportOptions; rules: string;
  catalogue: string | null; catalogueSha256: string | null; index: string; complete: boolean; reportComplete: boolean;
  derivedCatalogue: string | null; derivedCatalogueSha256: string | null; indexBoundary: number | null;
  reportError: string | null; captureFirst: number; captureLast: number; summaryAtSequence: number;
  unconfirmed: boolean;
}
export interface CataloguePage { files: FileReference[]; next: string | null; nextSha256: string | null }

/** A stream owns at most one bounded part, or its single indivisible oversized record. */
export class PartWriter {
  private chunks: Uint8Array[] = [];
  private bytes = 0;
  private count = 0;
  private order = 0;
  private first: number | null = null;
  private last: number | null = null;
  private initialized = false;
  private disk: BundleDisk; private type: string; private limit: number;
  private publish: (file: FileReference) => Promise<void>;
  constructor(disk: BundleDisk, type: string, limit: number, publish: (file: FileReference) => Promise<void>) {
    this.disk = disk; this.type = type; this.limit = limit; this.publish = publish;
  }
  private path(): string { return `${this.type}/part-${String(this.order + 1).padStart(6, "0")}.jsonl`; }
  private async initialize(): Promise<void> {
    if (!this.initialized) { this.order = Number(await this.disk.get("writer-order", this.type) ?? 0); this.initialized = true; }
  }
  async append(bytes: Uint8Array, sequence: number | null = null): Promise<Location> {
    await this.initialize();
    if (bytes.at(-1) !== 10) throw new Error("RECORD_REQUIRES_LF");
    if (this.bytes && this.bytes + bytes.length > this.limit) await this.flush();
    const location = { path: this.path(), offset: this.bytes, length: bytes.length };
    this.chunks.push(bytes); this.bytes += bytes.length; this.count++;
    this.first ??= sequence; this.last = sequence;
    if (this.bytes > this.limit) await this.flush();
    return location;
  }
  async flush(): Promise<void> {
    if (!this.count) return;
    const bytes = new Uint8Array(this.bytes); let offset = 0;
    for (const chunk of this.chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    const path = this.path(); await this.disk.write(path, one(bytes));
    await this.publish({ path, type: this.type, order: ++this.order, bytes: bytes.length, sha256: await sha256(bytes),
      count: this.count, firstSequence: this.first, lastSequence: this.last, oversized: bytes.length > this.limit });
    await this.disk.put("writer-order", this.type, this.order);
    this.chunks = []; this.bytes = 0; this.count = 0; this.first = null; this.last = null;
  }
}

/** Backwards-linked pages permit bounded publication without a growing root array. */
export class Catalogue {
  private files: FileReference[] = [];
  private bytes = 0;
  private page = 0;
  head: string | null = null;
  headSha256: string | null = null;
  private disk: BundleDisk; private limit: number; private directory: string;
  constructor(disk: BundleDisk, limit: number, directory = "catalog") { this.disk = disk; this.limit = limit; this.directory = directory; }
  async restore(head: string | null, hash: string | null): Promise<void> { this.head = head; this.headSha256 = hash; this.page = Number(await this.disk.get("catalogue-state", this.directory) ?? 0); }
  async add(file: FileReference): Promise<void> {
    const size = jsonBytes(file).length;
    if (this.files.length && (this.files.length >= 256 || this.bytes + size + 256 > this.limit)) await this.flush();
    this.files.push(file); this.bytes += size;
  }
  async flush(): Promise<void> {
    if (!this.files.length) return;
    const path = `${this.directory}/page-${String(++this.page).padStart(6, "0")}.json`;
    const bytes = jsonBytes({ files: this.files, next: this.head, nextSha256: this.headSha256 });
    await this.disk.write(path, one(bytes)); this.headSha256 = await sha256(bytes);
    await this.disk.put("catalogue-state", this.directory, this.page);
    this.head = path; this.files = []; this.bytes = 0;
  }
}
export async function publishDerived(disk: BundleDisk, manifest: BundleManifest, prefix = ""): Promise<void> {
  const catalogue = new Catalogue(disk, manifest.options.partSizeMiB * 1048576, `catalog-reports/${manifest.generation}`);
  let order = 0;
  for await (const row of disk.scan("files")) if (row.key === "index.html" ||
    (prefix ? row.key.startsWith(prefix) : row.key.startsWith("index/") || row.key.startsWith("report/"))) {
    const bytes = await readBytes(disk, row.key);
    await catalogue.add({ path: row.key, type: "derived", order: ++order, bytes: bytes.length, sha256: await sha256(bytes),
      count: 0, firstSequence: null, lastSequence: null, oversized: bytes.length > manifest.options.partSizeMiB * 1048576 });
  }
  await catalogue.flush(); manifest.derivedCatalogue = catalogue.head; manifest.derivedCatalogueSha256 = catalogue.headSha256;
  manifest.indexBoundary = manifest.journal.persisted;
}

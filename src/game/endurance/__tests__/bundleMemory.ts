import type { BundleDisk } from "../bundle/io";
export class MemoryDisk implements BundleDisk {
  files = new Map<string, Uint8Array>(); tables = new Map<string, Map<string, unknown>>();
  async write(path: string, data: AsyncIterable<Uint8Array>) {
    const chunks: Uint8Array[] = []; let size = 0;
    for await (const chunk of data) { chunks.push(chunk); size += chunk.length; }
    const bytes = new Uint8Array(size); let at = 0;
    for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.length; }
    this.files.set(path, bytes); await this.put("files", path, { path });
  }
  async *read(path: string, offset = 0, length?: number) {
    const bytes = this.files.get(path); if (!bytes) throw new Error("MISSING_FILE");
    // Deliberately split UTF-8 and LF boundaries.
    const upper = length === undefined ? bytes.length : Math.min(bytes.length, offset + length);
    for (let at = offset; at < upper; at += 127) yield bytes.slice(at, Math.min(upper, at + 127));
  }
  async size(path: string) { return this.files.get(path)?.length ?? 0; }
  async remove(path: string) { this.files.delete(path); this.tables.get("files")?.delete(path); }
  async put(table: string, key: string, value: unknown) { if (!this.tables.has(table)) this.tables.set(table, new Map()); this.tables.get(table)!.set(key, structuredClone(value)); }
  async get(table: string, key: string) { return structuredClone(this.tables.get(table)?.get(key)); }
  async *scan(table: string, prefix = "") { for (const [key, value] of [...this.tables.get(table)?.entries() ?? []].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) if (key.startsWith(prefix)) yield { key, value: structuredClone(value) }; }
}

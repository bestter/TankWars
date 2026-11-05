import { mkdir, open, rename, stat, rm } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { resolve, dirname, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";

/** Same disk contract as Chromium's adapter. SQLite keeps sorting and joins out of RAM. */
export class NodeBundleDisk {
  constructor(root, database = ":memory:") {
    this.root = resolve(root);
    this.db = new DatabaseSync(database);
    // This database is disposable derived working state, never native evidence.
    this.db.exec("PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF; PRAGMA cache_size=-2048; PRAGMA temp_store=FILE; CREATE TABLE IF NOT EXISTS rows (t TEXT, k TEXT, v TEXT, PRIMARY KEY(t,k)) WITHOUT ROWID");
  }
  path(path) {
    if (!/^[a-zA-Z0-9_./-]+$/.test(path) || path.startsWith("/") || path.split("/").some(p => !p || p === "." || p === "..")) throw new Error("INVALID_BUNDLE_PATH");
    const target = resolve(this.root, path);
    if (!target.startsWith(this.root + sep)) throw new Error("INVALID_BUNDLE_PATH");
    return target;
  }
  async write(path, chunks) {
    const target = this.path(path); await mkdir(dirname(target), { recursive: true });
    const candidate = target + ".tmp", file = await open(candidate, "w");
    try { for await (const bytes of chunks) await file.writeFile(bytes); await file.sync(); }
    finally { await file.close(); }
    await rename(candidate, target); await this.put("files", path, { path });
  }
  async *read(path, offset = 0, length) {
    if (length === 0) return;
    yield* createReadStream(this.path(path), { start: offset, ...(length === undefined ? {} : { end: offset + length - 1 }), highWaterMark: 65536 });
  }
  async size(path) { return (await stat(this.path(path))).size; }
  async remove(path) { await rm(this.path(path)); this.db.prepare("DELETE FROM rows WHERE t='files' AND k=?").run(path); }
  async put(table, key, value) { this.db.prepare("INSERT OR REPLACE INTO rows VALUES (?,?,?)").run(table, key, JSON.stringify(value)); }
  async get(table, key) { const row = this.db.prepare("SELECT v FROM rows WHERE t=? AND k=?").get(table, key); return row ? JSON.parse(row.v) : undefined; }
  async *scan(table, prefix = "") {
    const statement = this.db.prepare("SELECT k,v FROM rows WHERE t=? AND k>=? AND k<? ORDER BY k");
    for (const row of statement.iterate(table, prefix, prefix + "\uffff")) yield { key: row.k, value: JSON.parse(row.v) };
  }
  close() { this.db.close(); }
}

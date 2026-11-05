import { safePath, type BundleDisk } from "./io";

/** Temporary export files and indexes are separate from the game's archive database. */
export class BrowserDisk implements BundleDisk {
  private directory: FileSystemDirectoryHandle; private db: IDBDatabase; private id: string;
  private constructor(directory: FileSystemDirectoryHandle, db: IDBDatabase, id: string) {
    this.directory = directory; this.db = db; this.id = id;
  }
  static async create(id: string): Promise<BrowserDisk> {
    const root = await navigator.storage.getDirectory();
    const directory = await root.getDirectoryHandle(id, { create: true });
    // Open the index only after OPFS succeeds; denied storage must not leak an open database.
    // react-doctor-disable-next-line react-doctor/server-sequential-independent-await
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(`tankwars-export-${id}`, 1);
      request.onupgradeneeded = () => request.result.createObjectStore("rows", { keyPath: ["table", "key"] });
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    return new BrowserDisk(directory, db, id);
  }
  private async file(path: string, create = false): Promise<FileSystemFileHandle> {
    const parts = safePath(path).split("/"); let dir = this.directory;
    for (const part of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(part, { create });
    return dir.getFileHandle(parts[parts.length - 1], { create });
  }
  async write(path: string, data: AsyncIterable<Uint8Array>): Promise<void> {
    const writable = await (await this.file(path, true)).createWritable();
    try {
      for await (const chunk of data) await writable.write(new Uint8Array(chunk));
      await writable.close();
      await this.put("files", path, { path });
    } catch (error) { await writable.abort().catch(cleanup => console.warn("[Endurance] Temporary writer abort failed", cleanup)); throw error; }
  }
  async *read(path: string, offset = 0, length?: number): AsyncIterable<Uint8Array> {
    const file = await (await this.file(path)).getFile();
    const reader = file.slice(offset, length === undefined ? undefined : offset + length).stream().getReader();
    try { for (;;) { const next = await reader.read(); if (next.done) break; yield next.value; } }
    finally { reader.releaseLock(); }
  }
  async size(path: string): Promise<number> { return (await (await this.file(path)).getFile()).size; }
  async remove(path: string): Promise<void> {
    const parts = safePath(path).split("/"); let directory = this.directory;
    for (const part of parts.slice(0, -1)) directory = await directory.getDirectoryHandle(part);
    await directory.removeEntry(parts[parts.length - 1]);
    await new Promise<void>((resolve, reject) => {
      const tx = this.db.transaction("rows", "readwrite"); tx.objectStore("rows").delete(["files", path]);
      tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error); tx.onerror = () => reject(tx.error);
    });
  }
  async put(table: string, key: string, value: unknown): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const tx = this.db.transaction("rows", "readwrite"); tx.objectStore("rows").put({ table, key, value });
      tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error); tx.onerror = () => reject(tx.error);
    });
  }
  async get(table: string, key: string): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const request = this.db.transaction("rows").objectStore("rows").get([table, key]);
      request.onsuccess = () => resolve((request.result as { value: unknown } | undefined)?.value);
      request.onerror = () => reject(request.error);
    });
  }
  async *scan(table: string, prefix = ""): AsyncIterable<{ key: string; value: unknown }> {
    let after: string | undefined;
    for (;;) {
      const page = await new Promise<Array<{ key: string; value: unknown }>>((resolve, reject) => {
        const tx = this.db.transaction("rows");
        const request = tx.objectStore("rows").getAll(IDBKeyRange.bound([table, after ?? prefix], [table, prefix + "\uffff"], after !== undefined), 128);
        request.onsuccess = () => resolve(request.result as Array<{ key: string; value: unknown }>);
        request.onerror = () => reject(request.error);
      });
      if (!page.length) return;
      for (const row of page) yield row;
      after = page[page.length - 1].key;
    }
  }
  async download(path: string, name: string): Promise<void> {
    const url = URL.createObjectURL(await (await this.file(path)).getFile());
    try {
      const anchor = document.createElement("a"); anchor.href = url; anchor.download = name; anchor.click();
      // Keep the backing file alive while Chromium hands the file to its download manager.
      await new Promise(resolve => setTimeout(resolve, 1000));
    } finally { URL.revokeObjectURL(url); }
  }
  async dispose(): Promise<void> {
    this.db.close();
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.deleteDatabase(`tankwars-export-${this.id}`);
      request.onsuccess = () => resolve(); request.onerror = () => reject(request.error); request.onblocked = () => reject(new Error("EXPORT_INDEX_BLOCKED"));
    });
    await (await navigator.storage.getDirectory()).removeEntry(this.id, { recursive: true });
  }
}

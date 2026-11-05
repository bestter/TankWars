/** Disk-backed adapters: OPFS/IndexedDB in Chromium, filesystem/SQLite in Node. */
export interface BundleDisk {
  write(path: string, data: AsyncIterable<Uint8Array>): Promise<void>;
  read(path: string, offset?: number, length?: number): AsyncIterable<Uint8Array>;
  size(path: string): Promise<number>;
  remove(path: string): Promise<void>;
  put(table: string, key: string, value: unknown): Promise<void>;
  get(table: string, key: string): Promise<unknown>;
  scan(table: string, prefix?: string): AsyncIterable<{ key: string; value: unknown }>;
}
export const encoder = new TextEncoder();
export const jsonBytes = (value: unknown): Uint8Array => encoder.encode(JSON.stringify(value) + "\n");
export async function* one(value: Uint8Array): AsyncIterable<Uint8Array> { yield value; }
export function safePath(path: string): string {
  if (!/^[a-zA-Z0-9_./-]+$/.test(path) || path.startsWith("/") || path.split("/").some(p => !p || p === "." || p === "..")) throw new Error("INVALID_BUNDLE_PATH");
  return path;
}
export async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, "0")).join("");
}
export async function identity(value: string): Promise<string> { return sha256(encoder.encode(value)); }
export async function readBytes(disk: BundleDisk, path: string, offset?: number, length?: number): Promise<Uint8Array> {
  const chunks: Uint8Array[] = []; let size = 0;
  for await (const chunk of disk.read(safePath(path), offset, length)) { chunks.push(chunk); size += chunk.length; }
  const result = new Uint8Array(size); let at = 0;
  for (const chunk of chunks) { result.set(chunk, at); at += chunk.length; }
  return result;
}
export async function readJson(disk: BundleDisk, path: string): Promise<unknown> {
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await readBytes(disk, path))) as unknown;
}
export async function* lines(disk: BundleDisk, path: string): AsyncIterable<{ offset: number; bytes: Uint8Array }> {
  let fragments: Uint8Array[] = [], length = 0, offset = 0;
  for await (const chunk of disk.read(safePath(path))) {
    let start = 0;
    for (let i = 0; i < chunk.length; i++) if (chunk[i] === 10) {
      const tail = chunk.subarray(start, i + 1), bytes = new Uint8Array(length + tail.length);
      let at = 0; for (const fragment of fragments) { bytes.set(fragment, at); at += fragment.length; }
      bytes.set(tail, at); yield { offset, bytes }; offset += bytes.length;
      fragments = []; length = 0; start = i + 1;
    }
    if (start < chunk.length) { const tail = chunk.slice(start); fragments.push(tail); length += tail.length; }
  }
  if (length) throw new Error("UNCONFIRMED_TRAILING_LINE");
}

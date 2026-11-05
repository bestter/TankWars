import { encoder, type BundleDisk } from "./io";

const crcTable = new Uint32Array(256);
for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcTable[n] = c >>> 0; }
function crc(bytes: Uint8Array, value: number): number { for (const b of bytes) value = crcTable[(value ^ b) & 255] ^ (value >>> 8); return value >>> 0; }
function header(size: number): { bytes: Uint8Array; view: DataView } { const bytes = new Uint8Array(size); return { bytes, view: new DataView(bytes.buffer) }; }
interface Central { name: string; offset: number; size: number; crc: number }

/** ZIP64 STORE: content and central directory both stream from disk; no entry list in RAM. */
export async function writeZip(disk: BundleDisk, signal?: AbortSignal): Promise<void> {
  const generation = Number(await disk.get("zip-generation", "number") ?? 0) + 1;
  await disk.put("zip-generation", "number", generation);
  const centralTable = `zip-central-${generation}`;
  async function* stream(): AsyncIterable<Uint8Array> {
    let offset = 0, count = 0;
    for await (const file of disk.scan("files")) {
      signal?.throwIfAborted();
      const name = file.key;
      if (name === "bundle.zip") continue;
      const encoded = encoder.encode(name), start = offset;
      if (encoded.length > 65535) throw new Error("ZIP_FILENAME_TOO_LONG");
      const size = await disk.size(name);
      const local = header(30 + encoded.length + 20), v = local.view;
      v.setUint32(0, 0x04034b50, true); v.setUint16(4, 45, true); v.setUint16(6, 0x808, true);
      v.setUint32(18, 0xffffffff, true); v.setUint32(22, 0xffffffff, true); v.setUint16(26, encoded.length, true); v.setUint16(28, 20, true);
      local.bytes.set(encoded, 30); const at = 30 + encoded.length;
      v.setUint16(at, 1, true); v.setUint16(at + 2, 16, true); v.setBigUint64(at + 4, BigInt(size), true); v.setBigUint64(at + 12, BigInt(size), true);
      yield local.bytes; offset += local.bytes.length;
      let checksum = 0xffffffff, written = 0;
      for await (const bytes of disk.read(name)) { signal?.throwIfAborted(); checksum = crc(bytes, checksum); written += bytes.length; yield bytes; offset += bytes.length; }
      if (written !== size) throw new Error("ZIP_SOURCE_CHANGED");
      checksum = (checksum ^ 0xffffffff) >>> 0;
      const descriptor = header(24); descriptor.view.setUint32(0, 0x08074b50, true); descriptor.view.setUint32(4, checksum, true);
      descriptor.view.setBigUint64(8, BigInt(size), true); descriptor.view.setBigUint64(16, BigInt(size), true);
      yield descriptor.bytes; offset += 24;
      await disk.put(centralTable, String(count++).padStart(16, "0"), { name, offset: start, size, crc: checksum } satisfies Central);
    }
    const centralStart = offset;
    for await (const row of disk.scan(centralTable)) {
      signal?.throwIfAborted();
      const item = row.value as Central, name = encoder.encode(item.name), h = header(46 + name.length + 28), v = h.view;
      v.setUint32(0, 0x02014b50, true); v.setUint16(4, 45, true); v.setUint16(6, 45, true); v.setUint16(8, 0x808, true);
      v.setUint32(16, item.crc, true); v.setUint32(20, 0xffffffff, true); v.setUint32(24, 0xffffffff, true);
      v.setUint16(28, name.length, true); v.setUint16(30, 28, true); v.setUint32(42, 0xffffffff, true); h.bytes.set(name, 46);
      const at = 46 + name.length; v.setUint16(at, 1, true); v.setUint16(at + 2, 24, true);
      v.setBigUint64(at + 4, BigInt(item.size), true); v.setBigUint64(at + 12, BigInt(item.size), true); v.setBigUint64(at + 20, BigInt(item.offset), true);
      yield h.bytes; offset += h.bytes.length;
    }
    const end = header(98), v = end.view;
    v.setUint32(0, 0x06064b50, true); v.setBigUint64(4, 44n, true); v.setUint16(12, 45, true); v.setUint16(14, 45, true);
    v.setBigUint64(24, BigInt(count), true); v.setBigUint64(32, BigInt(count), true);
    v.setBigUint64(40, BigInt(offset - centralStart), true); v.setBigUint64(48, BigInt(centralStart), true);
    v.setUint32(56, 0x07064b50, true); v.setBigUint64(64, BigInt(offset), true); v.setUint32(72, 1, true);
    v.setUint32(76, 0x06054b50, true); v.setUint16(84, 65535, true); v.setUint16(86, 65535, true); v.setUint32(88, 0xffffffff, true); v.setUint32(92, 0xffffffff, true);
    yield end.bytes;
  }
  await disk.write("bundle.zip", stream());
}

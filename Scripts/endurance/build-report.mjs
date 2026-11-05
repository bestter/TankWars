import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { dirname, resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { NodeBundleDisk } from "./bundle-disk.mjs";
import { bundleRuntime } from "./bundle-runtime.mjs";

let runtime, source, target, temporary;
try {
  const [manifestPath, flag, output] = process.argv.slice(2);
  if (!manifestPath || flag !== "--output" || !output || process.argv.length !== 5 || !manifestPath.endsWith("manifest.json")) throw new Error("Usage: node Scripts/endurance/build-report.mjs <manifest.json> --output <new-directory>");
  const root = resolve(output);
  try { await stat(root); throw new Error("OUTPUT_ALREADY_EXISTS"); } catch (error) { if (error.code !== "ENOENT") throw error; }
  await mkdir(root, { recursive: true }); temporary = await mkdtemp(join(tmpdir(), "tankwars-report-"));
  runtime = await bundleRuntime(); source = new NodeBundleDisk(dirname(resolve(manifestPath)), join(temporary, "source.sqlite")); target = new NodeBundleDisk(root, join(temporary, "target.sqlite"));
  const manifest = await runtime.validateBundle(source);
  for await (const row of source.scan("read-files")) await target.write(row.key, source.read(row.key));
  // Catalog pages are small and chained. Preserve original data references verbatim.
  let catalogue = manifest.catalogue;
  while (catalogue) { await target.write(catalogue, source.read(catalogue)); catalogue = (await runtime.readJson(source, catalogue)).next; }
  for await (const row of source.scan("read-files", "terrains/")) for await (const line of runtime.lines(source, row.key)) {
    const terrain = JSON.parse(new TextDecoder().decode(line.bytes));
    await target.write(`index/terrains/${await runtime.identity(terrain.id)}.json`, runtime.one(runtime.jsonBytes({ id: terrain.id, location: { path: row.key, offset: line.offset, length: line.bytes.length } })));
  }
  for await (const row of source.scan("read-files", "captures/")) for await (const line of runtime.lines(source, row.key)) {
    const value = JSON.parse(new TextDecoder().decode(line.bytes));
    await target.put("capture-journal", String(value.journalSequence), { record: value.record, location: { path: row.key, offset: line.offset, length: line.bytes.length } });
  }
  for await (const row of source.scan("read-files", "journal/")) for await (const line of runtime.lines(source, row.key)) {
    const entry = JSON.parse(new TextDecoder().decode(line.bytes));
    await runtime.indexEntry(target, entry, { path: row.key, offset: line.offset, length: line.bytes.length }, await target.get("capture-journal", String(entry.sequence)), manifest.options.slowDecisionMs);
  }
  for await (const row of source.scan("read-files", "session/")) {
    const kind = row.key.split("/")[1];
    if (!["blocks", "rounds", "incidents"].includes(kind)) continue;
    for await (const line of runtime.lines(source, row.key)) {
      const value = JSON.parse(new TextDecoder().decode(line.bytes));
      await runtime.indexCollection(target, kind, value.record, { path: row.key, offset: line.offset, length: line.bytes.length }, value.capturedAtSequence);
    }
  }
  await runtime.renderReport(target, manifest);
  manifest.index = "index/root.json";
  await runtime.publishDerived(target, manifest);
  await target.write("manifest.json", runtime.one(runtime.jsonBytes({ ...manifest, index: "index/root.json", reportComplete: true, reportError: null })));
  console.log(JSON.stringify({ output: root, boundary: manifest.journal.persisted }));
} catch (error) { console.error(String(error)); process.exitCode = 1; }
finally { source?.close(); target?.close(); await runtime?.close(); if (temporary) await rm(temporary, { recursive: true, force: true }); }

import { readFile, stat, writeFile, mkdtemp, rm } from "node:fs/promises";
import { dirname, resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { constants as bufferLimits } from "node:buffer";

const MIB = 1024 * 1024;

async function startServer() {
  const { createServer } = await import("vite");
  return createServer({ configFile: false, server: { middlewareMode: true, hmr: false, ws: false, watch: null },
    optimizeDeps: { noDiscovery: true }, appType: "custom" });
}

const [path, ...args] = process.argv.slice(2);
if (!path) {
  console.error("Usage: node Scripts/read-shot-archive.mjs <archive.json> [--max-input-mib <n>] [--shot <key> | --shot-hash <sha256>] [--output <file>] [--replay] [--weapon <id> --angle <n> --power <n>]");
  process.exitCode = 1;
} else {
  let server, disk, temporary;
  try {
    const allowed = new Set(["--max-input-mib", "--shot", "--shot-hash", "--replay", "--weapon", "--angle", "--power", "--output"]);
    const options = new Map();
    for (let i = 0; i < args.length; i++) {
      if (!allowed.has(args[i]) || options.has(args[i])) throw new Error("INVALID_CLI_ARGUMENT");
      const option = args[i];
      const argument = option === "--replay" ? true : args[++i];
      if (argument === undefined || (typeof argument === "string" && (!argument.trim() || argument.startsWith("--")))) throw new Error("MISSING_CLI_VALUE");
      options.set(option, argument);
    }
    let key = options.get("--shot");
    const hash = options.get("--shot-hash");
    if (options.has("--shot") && hash !== undefined) throw new Error("SELECT_SHOT_BY_KEY_OR_HASH");
    if (hash !== undefined && (hash.length !== 64 || /[^0-9a-f]/.test(hash))) throw new Error("INVALID_SHOT_HASH");
    const alternativeFields = ["--weapon", "--angle", "--power"].filter(flag => options.has(flag)).length;
    if (alternativeFields !== 0 && alternativeFields !== 3) throw new Error("INCOMPLETE_ALTERNATIVE_COMMAND");
    let alternative;
    if (alternativeFields === 3) {
      const angle = Number(options.get("--angle"));
      const power = Number(options.get("--power"));
      if (!Number.isFinite(angle) || angle < 0 || angle > 180 || !Number.isInteger(power) || power < 1 || power > 99) {
        throw new Error("INVALID_ALTERNATIVE_COMMAND");
      }
      alternative = { weaponId: options.get("--weapon"), angle, power };
    }
    const maxInputMiB = Number(options.get("--max-input-mib") ?? 50);
    if (!Number.isSafeInteger(maxInputMiB) || maxInputMiB < 1 || maxInputMiB > Math.ceil(bufferLimits.MAX_STRING_LENGTH / MIB)) {
      throw new Error("INVALID_ARCHIVE_SIZE_LIMIT");
    }
    const maxInputBytes = Math.min(maxInputMiB * MIB, bufferLimits.MAX_STRING_LENGTH);
    if ((await stat(path)).size > maxInputBytes) throw new Error("ARCHIVE_TOO_LARGE: raise --max-input-mib for a larger JSON input");
    const text = await readFile(path, "utf8");
    let value;
    try { value = JSON.parse(text); }
    catch {
      const trimmed = text.trim();
      const nl = trimmed.indexOf("\n");
      const firstLine = (nl === -1 ? trimmed : trimmed.slice(0, nl)).trim();
      let header;
      try { header = firstLine ? JSON.parse(firstLine) : null; }
      catch { throw new Error("INVALID_ARCHIVE_JSON"); }
      if (!header || header.kind !== "journal-status") throw new Error("INVALID_ARCHIVE_JSON");
      const rows = trimmed.split(/\r?\n/).map(line => JSON.parse(line));
      value = { schemaVersion: header.schemaVersion, format: "legacy-journal", events: rows.length - 1 };
    }
    const isBundle = typeof value === "object" && value !== null && !Array.isArray(value) && value.format === "tankwars-endurance-bundle";
    let archive;
    if (isBundle) {
      if (!key && hash === undefined) throw new Error("SELECT_SHOT_FIRST");
      server = await startServer();
      const { NodeBundleDisk } = await import("./endurance/bundle-disk.mjs");
      temporary = await mkdtemp(join(tmpdir(), "tankwars-shot-"));
      disk = new NodeBundleDisk(dirname(resolve(path)), join(temporary, "index.sqlite"));
      const { extractShot, extractShotByHash } = await server.ssrLoadModule("/src/game/endurance/bundle/read.ts");
      if (hash === undefined) archive = await extractShot(disk, key);
      else {
        const selected = await extractShotByHash(disk, hash);
        archive = selected.archive;
        key = selected.shotKey;
      }
    } else if (hash !== undefined) throw new Error("SHOT_HASH_REQUIRES_BUNDLE");
    if (!isBundle && value.format !== "tankwars-shot-archive") {
      if (value.schemaVersion !== 1 || (value.format !== "legacy-journal" &&
        (typeof value.session !== "object" || value.session === null || !Array.isArray(value.blocks)))) throw new Error("NOT_A_SUPPORTED_ARCHIVE");
      console.log(JSON.stringify({ capabilities: { singleShotReplay: false }, reason: "Legacy report/journal: physical captures unavailable", sourceSchema: value.schemaVersion ?? null }, null, 2));
      process.exitCode = 2;
    } else {
      server ??= await startServer();
      const { validateArchive } = await server.ssrLoadModule("/src/game/diagnostics/validate.ts");
      archive ??= validateArchive(value);
      const shots = archive.records.filter(r => r.input.kind === "pre-shot");
      const recordedLaunches = new Set(archive.records.filter(r => r.input.kind === "projectile-launched").map(r => r.shotKey));
      const matches = key || hash !== undefined
        ? shots.filter(r => r.shotKey === key || (hash === undefined && String(r.input.shot.shotId) === key)) : [];
      if (matches.length > 1) throw new Error("AMBIGUOUS_SHOT_ID_USE_FULL_KEY");
      const selected = matches[0];
      if ((key || hash !== undefined) && !selected) throw new Error("SHOT_NOT_FOUND");
      if ((options.has("--replay") || options.has("--weapon")) && !selected) throw new Error("SELECT_SHOT_FIRST");
      let chain;
      if (selected) {
        const { filterArchive } = await server.ssrLoadModule("/src/game/diagnostics/export.ts");
        const subset = filterArchive(archive, { shotKey: selected.shotKey });
        chain = subset.records;
        if (options.has("--output")) await writeFile(options.get("--output"), JSON.stringify(validateArchive(subset)) + "\n", { flag: "wx" });
      }
      if (options.has("--output") && !selected) throw new Error("SELECT_SHOT_FIRST");
      const result = { capabilities: { archiveIntegrity: typeof archive.integrity === "string",
        recordedInitialProjectile: shots.every(s => recordedLaunches.has(s.shotKey)) },
        manifest: { ...archive, records: undefined, terrains: undefined }, shots: shots.map(r => ({ id: r.shotKey, sequence: r.sequence, shot: r.input.shot })),
        chain };
      if (selected && (options.has("--replay") || options.has("--weapon"))) {
        const { replayShot } = await server.ssrLoadModule("/src/game/diagnostics/replay.ts");
        const replay = replayShot(archive, selected.shotKey, alternative);
        result.replay = replay;
        if (!replay.complete || replay.physicalDivergence || replay.economicDivergence) process.exitCode = 2;
      }
      console.log(JSON.stringify(result, null, 2));
    }
  } catch (error) { console.error(String(error)); process.exitCode = 1; }
  finally { disk?.close(); await server?.close(); if (temporary) await rm(temporary, { recursive: true, force: true }); }
}

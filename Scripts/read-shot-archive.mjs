import { readFile } from "node:fs/promises";
import { createServer } from "vite";

const [path, ...args] = process.argv.slice(2);
if (!path) {
  console.error("Usage: node Scripts/read-shot-archive.mjs <archive.json> [--shot <key>] [--replay] [--weapon <id> --angle <n> --power <n>]");
  process.exitCode = 1;
} else {
  let server;
  try {
    const text = await readFile(path, "utf8");
    let value;
    try { value = JSON.parse(text); }
    catch {
      const rows = text.trim().split(/\r?\n/).map(line => JSON.parse(line));
      if (!rows.length || rows[0].kind !== "journal-status") throw new Error("INVALID_ARCHIVE_JSON");
      value = { schemaVersion: rows[0].schemaVersion, format: "legacy-journal", events: rows.length - 1 };
    }
    if (value.format !== "tankwars-shot-archive") {
      if (value.schemaVersion !== 1 || (value.format !== "legacy-journal" &&
        (typeof value.session !== "object" || value.session === null || !Array.isArray(value.blocks)))) throw new Error("NOT_A_SUPPORTED_ARCHIVE");
      console.log(JSON.stringify({ capabilities: { singleShotReplay: false }, reason: "Legacy report/journal: physical captures unavailable", sourceSchema: value.schemaVersion ?? null }, null, 2));
      process.exitCode = 2;
    } else {
      server = await createServer({ configFile: false, server: { middlewareMode: true, hmr: false, ws: false, watch: null },
        optimizeDeps: { noDiscovery: true }, appType: "custom" });
      const { validateArchive } = await server.ssrLoadModule("/src/game/diagnostics/validate.ts");
      const archive = validateArchive(value);
      const allowed = new Set(["--shot", "--replay", "--weapon", "--angle", "--power"]);
      const options = new Map();
      for (let i = 0; i < args.length; i++) {
        if (!allowed.has(args[i]) || options.has(args[i])) throw new Error("INVALID_CLI_ARGUMENT");
        const option = args[i]; options.set(option, option === "--replay" ? true : args[++i]);
        if (options.get(option) === undefined) throw new Error("MISSING_CLI_VALUE");
      }
      const shots = archive.records.filter(r => r.input.kind === "pre-shot");
      const recordedLaunches = new Set(archive.records.filter(r => r.input.kind === "projectile-launched").map(r => r.shotKey));
      const key = options.get("--shot");
      const matches = key ? shots.filter(r => r.shotKey === key || String(r.input.shot.shotId) === key) : [];
      if (matches.length > 1) throw new Error("AMBIGUOUS_SHOT_ID_USE_FULL_KEY");
      const selected = matches[0];
      if (key && !selected) throw new Error("SHOT_NOT_FOUND");
      if ((options.has("--replay") || options.has("--weapon")) && !selected) throw new Error("SELECT_SHOT_FIRST");
      const alternativeFields = ["--weapon", "--angle", "--power"].filter(flag => options.has(flag)).length;
      if (alternativeFields !== 0 && alternativeFields !== 3) throw new Error("INCOMPLETE_ALTERNATIVE_COMMAND");
      let chain;
      if (selected) {
        const { filterArchive } = await server.ssrLoadModule("/src/game/diagnostics/export.ts");
        chain = filterArchive(archive, { shotKey: selected.shotKey }).records;
      }
      const result = { capabilities: { archiveIntegrity: typeof archive.integrity === "string",
        recordedInitialProjectile: shots.every(s => recordedLaunches.has(s.shotKey)) },
        manifest: { ...archive, records: undefined, terrains: undefined }, shots: shots.map(r => ({ id: r.shotKey, sequence: r.sequence, shot: r.input.shot })),
        chain };
      if (selected && (options.has("--replay") || options.has("--weapon"))) {
        const { replayShot } = await server.ssrLoadModule("/src/game/diagnostics/replay.ts");
        const alternative = options.has("--weapon") ? { weaponId: options.get("--weapon"), angle: Number(options.get("--angle")), power: Number(options.get("--power")) } : undefined;
        const replay = replayShot(archive, selected.shotKey, alternative);
        result.replay = replay;
        if (!replay.complete || replay.physicalDivergence || replay.economicDivergence) process.exitCode = 2;
      }
      console.log(JSON.stringify(result, null, 2));
    }
  } catch (error) { console.error(String(error)); process.exitCode = 1; }
  finally { await server?.close(); }
}

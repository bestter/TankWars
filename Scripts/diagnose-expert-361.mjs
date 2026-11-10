import { createServer } from "vite";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, writeFile } from "node:fs/promises";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
let server;
try {
  const args = process.argv.slice(2), values = new Map();
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (!["--output", "--seed", "--case", "--matrix"].includes(key) || values.has(key)) throw new Error("INVALID_ARGUMENT");
    const value = key === "--matrix" ? true : args[++i];
    if (value === undefined || typeof value === "string" && value.startsWith("--")) throw new Error("MISSING_ARGUMENT_VALUE");
    values.set(key, value);
  }
  const seed = values.has("--seed") ? Number(values.get("--seed")) : 0x361;
  if (!Number.isSafeInteger(seed) || seed < 0 || seed > 0xffffffff) throw new Error("SEED_MUST_BE_UINT32");
  server = await createServer({ root, configFile: false, define: { "import.meta.env.DEV": "false" },
    server: { middlewareMode: true, hmr: false, ws: false, watch: null }, optimizeDeps: { noDiscovery: true }, appType: "custom" });
  const bench = await server.ssrLoadModule("/src/game/entities/ai/__tests__/issue361Bench.ts");
  let fixtures = bench.loadFixtures(join(root, "src/game/entities/ai/__tests__/fixtures/issue361"));
  if (values.has("--case")) fixtures = fixtures.filter(f => f.id === values.get("--case"));
  if (!fixtures.length) throw new Error("UNKNOWN_CASE");
  const cases = [];
  for (const fixture of fixtures) {
    const replay = bench.historicalReplay(fixture);
    if (!replay.complete || replay.physicalDivergence || replay.economicDivergence) throw new Error(`HISTORICAL_REPLAY_FAILED:${fixture.id}`);
    const runs = [];
    for (const wind of values.has("--matrix") ? [-20, 0, 20] : [fixture.state.windForce])
      for (const runSeed of values.has("--matrix") ? [seed, (seed + 1) >>> 0] : [seed])
        // runDecision installs and restores the process-wide game RNG for each run.
        // react-doctor-disable-next-line react-doctor/async-await-in-loop
        runs.push(await bench.runDecision(fixture, runSeed, wind));
    const probes = [];
    for (const power of [95, 99]) for (const variant of ["full", "low", "high"])
      probes.push(bench.probeSolver(fixture, power, variant));
    cases.push({ id: fixture.id, shotKey: fixture.shotKey,
      historical: { command: fixture.historical.final, replayComplete: replay.complete,
        physicalDivergence: replay.physicalDivergence, economicDivergence: replay.economicDivergence },
      witness: fixture.witness, runs, probes });
  }
  const report = { schemaVersion: 1, format: "tankwars-expert-361-decision-bench", createdAt: new Date().toISOString(),
    limitations: ["Controlled seeded AI draws are not the historical AI RNG tape.",
      "Solver probes change only the experiment, not EXPERT or its policies.",
      "No witness means no certificate retained, not proven inaccessibility.",
      "Forecast steps include stabilization and are not projectile flight time."], cases };
  const text = JSON.stringify(report, null, 2) + "\n";
  if (values.has("--output")) {
    const output = resolve(values.get("--output"));
    await mkdir(dirname(output), { recursive: true }); await writeFile(output, text, { flag: "wx" });
    console.log(JSON.stringify({ output, cases: cases.map(c => ({ id: c.id, runs: c.runs.map(r => ({ seed: r.rng.seed,
      wind: r.wind, phase: r.phase, candidateCount: r.candidateCount, target: r.observation.target?.playerId,
      command: r.command, nearbyRock: r.nearbyRock, useful: r.usefulOnHistoricalTarget,
      witnessUseful: r.witnessUseful, draws: r.rng.draws.length, elapsedMs: r.elapsedMs })) })) }, null, 2));
  } else process.stdout.write(text);
} catch (error) { console.error(String(error)); process.exitCode = 1; }
finally { await server?.close(); }

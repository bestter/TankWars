// Share the game's validator rather than maintaining a second schema in Python.
import { readFile, writeFile, rename, unlink } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
let server, temporary;
try {
  const [mode, input, output] = process.argv.slice(2);
  if (!["validate", "convert"].includes(mode) || !input || (mode === "convert" && !output)) {
    throw new Error("Usage: node Scripts/endurance/scenario.mjs validate scenario.json | convert sketch.txt scenario.json");
  }
  if (output && resolve(input) === resolve(output)) throw new Error("Source and output must differ");
  server = await createServer({ root, configFile: false, server: { middlewareMode: true, hmr: false, ws: false, watch: null },
    optimizeDeps: { noDiscovery: true }, appType: "custom" });
  const { validateScenario, convertScenarioSketch } = await server.ssrLoadModule("/src/game/endurance/scenario.ts");
  const text = await readFile(input, "utf8");
  const scenario = mode === "convert" ? convertScenarioSketch(text) : validateScenario(JSON.parse(text));
  const result = JSON.stringify(scenario, null, 2) + "\n";
  if (mode === "convert") {
    temporary = resolve(output) + "." + process.pid + ".tmp";
    await writeFile(temporary, result, { flag: "wx" });
    await rename(temporary, output); temporary = undefined;
  } else process.stdout.write(result);
} catch (error) {
  console.error(String(error)); process.exitCode = 1;
} finally {
  await server?.close();
  if (temporary) await unlink(temporary).catch(() => {});
}

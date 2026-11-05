import { readFile } from "node:fs/promises";
import { createServer } from "vite";
import { dirname, resolve, join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { NodeBundleDisk } from "./bundle-disk.mjs";

let server, disk, temporary;
try {
  server = await createServer({ configFile: false, server: { middlewareMode: true, hmr: false, ws: false, watch: null },
    optimizeDeps: { noDiscovery: true }, appType: "custom" });
  const { validateArchive } = await server.ssrLoadModule("/src/game/diagnostics/validate.ts");
  const value = JSON.parse(await readFile(process.argv[2], "utf8"));
  if (value.format === "tankwars-endurance-bundle") {
    temporary = await mkdtemp(join(tmpdir(), "tankwars-validate-"));
    disk = new NodeBundleDisk(dirname(resolve(process.argv[2])), join(temporary, "index.sqlite"));
    const { validateBundle } = await server.ssrLoadModule("/src/game/endurance/bundle/read.ts");
    await validateBundle(disk);
  } else validateArchive(value);
} catch (error) {
  console.error(String(error)); process.exitCode = 1;
} finally {
  await server?.close();
  disk?.close(); if (temporary) await rm(temporary, { recursive: true, force: true });
}

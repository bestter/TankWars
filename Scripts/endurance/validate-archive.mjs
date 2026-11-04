import { readFile } from "node:fs/promises";
import { createServer } from "vite";

let server;
try {
  server = await createServer({ configFile: false, server: { middlewareMode: true, hmr: false, ws: false, watch: null },
    optimizeDeps: { noDiscovery: true }, appType: "custom" });
  const { validateArchive } = await server.ssrLoadModule("/src/game/diagnostics/validate.ts");
  validateArchive(JSON.parse(await readFile(process.argv[2], "utf8")));
} catch (error) {
  console.error(String(error)); process.exitCode = 1;
} finally {
  await server?.close();
}

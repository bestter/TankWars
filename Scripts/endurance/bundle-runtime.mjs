import { createServer } from "vite";

export async function bundleRuntime() {
  const server = await createServer({ configFile: false, server: { middlewareMode: true, hmr: false, ws: false, watch: null }, optimizeDeps: { noDiscovery: true }, appType: "custom" });
  try {
    const [read, io, report, format] = await Promise.all([
      server.ssrLoadModule("/src/game/endurance/bundle/read.ts"),
      server.ssrLoadModule("/src/game/endurance/bundle/io.ts"),
      server.ssrLoadModule("/src/game/endurance/bundle/report.ts"),
      server.ssrLoadModule("/src/game/endurance/bundle/format.ts"),
    ]);
    return { ...read, ...io, ...report, ...format, close: () => server.close() };
  } catch (error) { await server.close(); throw error; }
}

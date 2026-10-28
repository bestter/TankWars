import { defineConfig } from "vite";
export default defineConfig({ build: { outDir: "artifacts/validation-352/dist",
  rollupOptions: { input: ["artifacts/validation-352/index.html", "artifacts/validation-352/endurance-logs.html"] } } });

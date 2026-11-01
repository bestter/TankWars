import { defineConfig } from "vite";
export default defineConfig({
  build: {
    outDir: "artifacts/validation-352/dist",
    rollupOptions: {
      input: ["Scripts/validation-352/index.html", "Scripts/validation-352/endurance-logs.html"],
    },
  },
});

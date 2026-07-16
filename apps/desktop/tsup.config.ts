import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: { main: "src/main/main.ts" },
    format: ["cjs"],
    platform: "node",
    target: "es2023",
    external: ["electron", "node:sqlite"],
    noExternal: ["@vc-agent/contracts", "@vc-agent/core", "@vc-agent/persistence"],
    outDir: "dist/main",
    clean: true
  },
  {
    entry: { preload: "src/preload/preload.ts" },
    format: ["cjs"],
    platform: "node",
    target: "es2023",
    external: ["electron"],
    outDir: "dist/preload",
    clean: true
  }
]);

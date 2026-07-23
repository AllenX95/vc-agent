import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: { main: "src/main/main.ts" },
    format: ["cjs"],
    platform: "node",
    target: "es2023",
    external: ["electron", "node:sqlite"],
    noExternal: ["@vc-agent/capabilities", "@vc-agent/contracts", "@vc-agent/core", "@vc-agent/host-services", "@vc-agent/persistence", "@vc-agent/pi-adapter", "pi-mcp-adapter"],
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

import { defineConfig } from "tsup";

export default defineConfig({
  entry: { index: "src/index.ts" },
  format: ["esm"],
  platform: "node",
  target: "es2023",
  external: [/^@earendil-works\//, "electron"],
  noExternal: ["@vc-agent/contracts", "@vc-agent/pi-adapter"],
  outDir: "dist",
  clean: true
});

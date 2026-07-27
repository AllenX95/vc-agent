import { defineConfig } from "tsup";

export default defineConfig({
  entry: { index: "src/index.ts" },
  format: ["esm"],
  platform: "node",
  target: "es2023",
  external: ["electron"],
  noExternal: [/^@earendil-works\//, "@vc-agent/contracts", "@vc-agent/pi-adapter", "typebox"],
  banner: {
    js: 'import { createRequire as __vcCreateRequire } from "node:module"; const require = __vcCreateRequire(import.meta.url);'
  },
  outDir: "dist",
  clean: true
});

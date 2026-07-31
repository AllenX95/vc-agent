import { defineConfig } from "tsup";

const shared = {
  format: "esm" as const,
  platform: "node" as const,
  target: "es2023",
  external: ["electron"],
  noExternal: [/^@earendil-works\//, "@vc-agent/contracts", "@vc-agent/pi-adapter", "pi-web-access", "typebox"],
  banner: {
    js: 'import { createRequire as __vcCreateRequire } from "node:module"; const require = __vcCreateRequire(import.meta.url);'
  },
  clean: true
};

export default defineConfig([
  {
    ...shared,
    entry: { index: "src/index.ts" },
    outDir: "dist"
  },
  {
    ...shared,
    entry: { index: "src/test-index.ts" },
    outDir: "dist-test"
  }
]);

import { defineConfig } from "tsup";

export default defineConfig({
  entry: { index: "src/index.ts" }, format: ["esm"], platform: "node", target: "es2023",
  external: ["electron"], noExternal: ["@vc-agent/contracts"], outDir: "dist", clean: true
});

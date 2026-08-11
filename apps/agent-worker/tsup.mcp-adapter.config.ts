import { defineConfig } from "tsup";

/**
 * The Pi MCP extension is loaded by path at runtime, so it must remain a
 * standalone Worker asset rather than being hidden in the Worker entry's
 * inlined @vc-agent/pi-adapter code. Bundle its runtime dependencies into the
 * same file so packaged Workers do not need a node_modules tree beside them.
 */
export default defineConfig({
  entry: { "pi-mcp-adapter": "node_modules/pi-mcp-adapter/index.ts" },
  format: "esm",
  platform: "node",
  target: "es2023",
  bundle: true,
  splitting: false,
  sourcemap: false,
  clean: false,
  outDir: "dist",
  noExternal: ["@modelcontextprotocol/sdk", "@sinclair/typebox", "zod"]
});

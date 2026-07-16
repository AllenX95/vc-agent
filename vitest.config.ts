import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/{architecture,contracts,persistence,pi-adapter}/**/*.test.ts"]
  }
});

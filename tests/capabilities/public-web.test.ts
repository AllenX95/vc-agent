import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { detectWebResearchIntent } from "@vc-agent/host-services";

describe("Extension-owned public web", () => {
  it("preactivates only clear current-web intent", () => {
    expect(detectWebResearchIntent("Search the latest market news")).toBe(true);
    expect(detectWebResearchIntent("请联网查找最新行业资料")).toBe(true);
    expect(detectWebResearchIntent("Read https://example.com/report")).toBe(true);
    expect(detectWebResearchIntent("Analyze the supplied company materials")).toBe(false);
  });

  it("has no production Host PublicWeb implementation or Host web executor", () => {
    const root = resolve(".");
    expect(existsSync(resolve(root, "packages/host-services/src/public-web.ts"))).toBe(false);
    const capabilities = readFileSync(resolve(root, "packages/capabilities/src/index.ts"), "utf8");
    expect(capabilities).not.toContain("createWebSearchCapability");
    expect(capabilities).not.toContain("createWebFetchCapability");
    expect(capabilities).toContain("createRuntimeExtensionCapability");
    expect(capabilities).not.toContain("createProjectCommandCapability");
    expect(existsSync(resolve(root, "apps/utility-worker/src/project-command.ts"))).toBe(false);
  });
});

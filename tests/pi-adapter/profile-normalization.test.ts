import { describe, expect, it } from "vitest";
import { resolvePiModelProfile } from "../../packages/pi-adapter/src/pi-session.js";

describe("resolvePiModelProfile", () => {
  it("maps the saved MiMo Anthropic endpoint to the built-in OpenAI-compatible MiMo provider", () => {
    expect(resolvePiModelProfile({ provider: "https://api.xiaomimimo.com/anthropic", model: "mimo-v2.5" })).toEqual({
      provider: "xiaomi",
      model: "mimo-v2.5"
    });
  });

  it("leaves ordinary Provider ids unchanged", () => {
    expect(resolvePiModelProfile({ provider: "anthropic", model: "claude-sonnet" })).toEqual({
      provider: "anthropic",
      model: "claude-sonnet"
    });
  });
});

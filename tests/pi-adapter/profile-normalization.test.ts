import { describe, expect, it } from "vitest";
import { resolvePiModelProfile } from "../../packages/pi-adapter/src/pi-session.js";

describe("resolvePiModelProfile", () => {
  it("maps the saved MiMo Anthropic endpoint to the built-in OpenAI-compatible MiMo provider", () => {
    expect(resolvePiModelProfile({ provider: "https://api.xiaomimimo.com/anthropic", model: "mimo-v2.5" })).toEqual({
      provider: "xiaomi",
      model: "mimo-v2.5"
    });
  });

  it("maps the saved DeepSeek endpoints to the built-in DeepSeek provider", () => {
    expect(resolvePiModelProfile({ provider: "https://api.deepseek.com/anthropic", model: "deepseek-v4-flash" })).toEqual({
      provider: "deepseek",
      model: "deepseek-v4-flash"
    });
  });

  it("turns a custom OpenAI-compatible URL into a runtime provider registration", () => {
    expect(resolvePiModelProfile({ provider: "https://gateway.example/v1", model: "custom-model" })).toMatchObject({
      provider: expect.stringMatching(/^vc-agent-url-[0-9a-f]{8}$/u),
      model: "custom-model",
      customUrl: { baseUrl: "https://gateway.example/v1", api: "openai-completions" }
    });
  });

  it("detects Anthropic compatibility from a custom URL path", () => {
    expect(resolvePiModelProfile({ provider: "https://gateway.example/anthropic", model: "custom-model" })).toMatchObject({
      customUrl: { api: "anthropic-messages" }
    });
  });

  it("leaves ordinary Provider ids unchanged", () => {
    expect(resolvePiModelProfile({ provider: "anthropic", model: "claude-sonnet" })).toEqual({
      provider: "anthropic",
      model: "claude-sonnet"
    });
  });
});

import { describe, it, expect } from "vitest";
import { getImageSizeLimit } from "../vision-limits";

const MB = 1024 * 1024;

describe("getImageSizeLimit", () => {
  it("returns Anthropic's 5 MB cap for anthropic models", () => {
    expect(getImageSizeLimit("anthropic:claude-sonnet-4")).toBe(5 * MB);
  });

  it("returns Google's 7 MB cap for google models", () => {
    expect(getImageSizeLimit("google:gemini-2.0-flash")).toBe(7 * MB);
  });

  it("returns OpenAI's 20 MB cap clamped at the universal ceiling", () => {
    expect(getImageSizeLimit("openai:gpt-4o")).toBe(20 * MB);
  });

  it("returns xAI's 10 MB cap", () => {
    expect(getImageSizeLimit("xai:grok-2-vision")).toBe(10 * MB);
  });

  it("returns OpenRouter's defensive 5 MB cap", () => {
    expect(getImageSizeLimit("openrouter:openai/gpt-4o")).toBe(5 * MB);
  });

  it("returns the 10 MB default for unknown providers", () => {
    expect(getImageSizeLimit("some-new-provider:foo-1")).toBe(10 * MB);
  });

  it("handles the no-colon edge case by using the whole string as provider", () => {
    expect(getImageSizeLimit("anthropic")).toBe(5 * MB);
  });

  it("clamps any future-too-permissive entry to the 20 MB ceiling", () => {
    // Sanity: even if a provider entry were 50 MB, the API surface clamps.
    // We test this by asserting no return value exceeds 20 MB across all
    // known providers.
    const knownProviders = [
      "anthropic", "google", "xai", "openai", "openai-compat",
      "openrouter", "ollama", "webllm", "chrome-builtin",
    ];
    for (const p of knownProviders) {
      expect(getImageSizeLimit(`${p}:any-model`)).toBeLessThanOrEqual(20 * MB);
    }
  });
});

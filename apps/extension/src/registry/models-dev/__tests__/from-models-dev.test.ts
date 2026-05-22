import { describe, it, expect } from "vitest";
import { fromModelsDevProvider } from "../from-models-dev";
import { QUIRKS } from "../quirks";
import {
  ANTHROPIC_FIXTURE,
  OPENAI_COMPATIBLE_FIXTURE,
  UNSUPPORTED_FIXTURE,
} from "./fixtures";

describe("fromModelsDevProvider", () => {
  it("maps a standard byok provider", () => {
    const result = fromModelsDevProvider(ANTHROPIC_FIXTURE, QUIRKS.anthropic);

    expect(result.id).toBe("anthropic");
    expect(result.name).toBe("Anthropic");
    expect(result.setup).toBe("byok");
    expect(result.icon).toEqual({
      light: "anthropic.svg",
      dark: "anthropic-dark.svg",
    });
    expect(result.configSchema).toEqual([
      {
        key: "apiKey",
        label: "API Key",
        type: "password",
        required: true,
        placeholder: "sk-...",
      },
    ]);
  });

  it("maps a Haiku model with the expected capabilities, limits, and pricing", () => {
    const result = fromModelsDevProvider(ANTHROPIC_FIXTURE, QUIRKS.anthropic);
    const haiku = result.models.find((m) => m.id === "claude-haiku-4-5");

    expect(haiku).toBeDefined();
    expect(haiku!.name).toBe("Claude Haiku 4.5 (latest)");
    expect(haiku!.capabilities.sort()).toEqual(
      ["chat", "tools", "vision", "thinking"].sort(),
    );
    expect(haiku!.contextWindow).toBe(200_000);
    expect(haiku!.maxOutputTokens).toBe(64_000);
    expect(haiku!.pricing).toEqual({ inputPer1M: 1, outputPer1M: 5 });
    expect(haiku!.recommended).toBe(true);
    expect(haiku!.status).toBeUndefined();
  });

  it("filters deprecated models out unconditionally", () => {
    const result = fromModelsDevProvider(ANTHROPIC_FIXTURE, QUIRKS.anthropic);
    const ids = result.models.map((m) => m.id);
    expect(ids).not.toContain("claude-3-opus-20240229");
  });

  it("filters alpha/beta models out by default", () => {
    const result = fromModelsDevProvider(ANTHROPIC_FIXTURE, QUIRKS.anthropic);
    const ids = result.models.map((m) => m.id);
    expect(ids).not.toContain("claude-experimental-alpha");
  });

  it("includes alpha/beta models when includePreview is true", () => {
    const result = fromModelsDevProvider(ANTHROPIC_FIXTURE, QUIRKS.anthropic, {
      includePreview: true,
    });
    const ids = result.models.map((m) => m.id);
    expect(ids).toContain("claude-experimental-alpha");
    const alpha = result.models.find((m) => m.id === "claude-experimental-alpha");
    expect(alpha!.status).toBe("alpha");
  });

  it("uses an apiKey-only config schema for openai-compatible providers (baseUrl baked in)", () => {
    const result = fromModelsDevProvider(OPENAI_COMPATIBLE_FIXTURE, undefined);
    expect(result.configSchema?.map((f) => f.key)).toEqual(["apiKey"]);
  });

  it("maps a non-vision text-only model with no thinking", () => {
    const result = fromModelsDevProvider(OPENAI_COMPATIBLE_FIXTURE, undefined);
    const llama = result.models.find((m) => m.id === "llama-3.3-70b-versatile");
    expect(llama!.capabilities.sort()).toEqual(["chat", "tools"].sort());
  });

  it("uses fallback description and undefined icon for unknown providers", () => {
    const result = fromModelsDevProvider(UNSUPPORTED_FIXTURE, undefined);
    expect(result.icon).toEqual({ light: "" });
    expect(result.description).toBeTruthy();
  });

  it("createLanguageModel throws for providers without bundled SDK", () => {
    const result = fromModelsDevProvider(UNSUPPORTED_FIXTURE, undefined);
    expect(() =>
      result.createLanguageModel({ apiKey: "x" }, "foo"),
    ).toThrow(/No bundled SDK/);
  });
});

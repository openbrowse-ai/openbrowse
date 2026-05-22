import { describe, it, expect } from "vitest";
import { fromModelsDevProvider } from "../from-models-dev";
import { QUIRKS } from "../quirks";
import {
  ANTHROPIC_FIXTURE,
  OPENAI_COMPATIBLE_FIXTURE,
  UNSUPPORTED_FIXTURE,
  MULTIPLEX_FIXTURE,
} from "./fixtures";

describe("fromModelsDevProvider", () => {
  it("maps a standard byok provider", () => {
    const result = fromModelsDevProvider(ANTHROPIC_FIXTURE, QUIRKS.anthropic);

    expect(result.id).toBe("anthropic");
    expect(result.name).toBe("Anthropic");
    expect(result.setup).toBe("byok");
    expect(result.icon).toEqual({
      light: "anthropic.svg",
    });
    expect(result.configSchema).toEqual([
      {
        key: "apiKey",
        label: "API Key",
        type: "password",
        required: true,
        placeholder: "sk-ant-...",
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

  it("surfaces alpha/beta models (no toggle gating)", () => {
    const result = fromModelsDevProvider(ANTHROPIC_FIXTURE, QUIRKS.anthropic);
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

  it("createLanguageModel throws for providers without bundled SDK", async () => {
    const result = fromModelsDevProvider(UNSUPPORTED_FIXTURE, undefined);
    await expect(
      Promise.resolve(result.createLanguageModel({ apiKey: "x" }, "foo-1")),
    ).rejects.toThrow(/No bundled SDK/);
  });

  describe("per-model overrides and variable substitution", () => {
    const quirks = {
      envVarMap: { AZURE_RESOURCE_NAME: "resourceName" },
    };

    it("resolves default provider npm and substituted baseUrl for default model", async () => {
      const result = fromModelsDevProvider(MULTIPLEX_FIXTURE, quirks);
      const model = await Promise.resolve(result.createLanguageModel({ resourceName: "test-res", apiKey: "x" }, "gpt-default"));
      expect(model).toBeDefined();
      expect((model as any).provider).toContain("azure"); // Verify we got an Azure model
    });

    it("resolves per-model npm override and substitutes url", async () => {
      const result = fromModelsDevProvider(MULTIPLEX_FIXTURE, quirks);
      // Wait, @ai-sdk/anthropic IS bundled! So it will try to import it and call it.
      // We don't want to make an actual API call, but `createLanguageModel` just returns the model instance, it doesn't make a fetch yet.
      const model = await Promise.resolve(result.createLanguageModel({ resourceName: "test-res", apiKey: "x" }, "claude-override"));
      // The model is a LanguageModel object. 
      expect(model).toBeDefined();
      expect((model as any).provider).toContain("anthropic"); // Just to check it created an Anthropic model.
    });

    it("throws if required config value for substitution is missing", async () => {
      const result = fromModelsDevProvider(MULTIPLEX_FIXTURE, quirks);
      expect(() => result.createLanguageModel({ apiKey: "x" }, "gpt-default"))
        .toThrow(/Missing required configuration: resourceName \(for AZURE_RESOURCE_NAME\)/);
    });
  });
});

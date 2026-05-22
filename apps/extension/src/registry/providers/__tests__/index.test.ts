import { describe, it, expect } from "vitest";
import { providers, getProvider } from "../index";

describe("providers (snapshot-derived)", () => {
  it("includes the special browser-ai and web-llm providers first", () => {
    expect(providers[0]?.id).toBe("browser-ai");
    expect(providers[1]?.id).toBe("web-llm");
  });

  it("includes anthropic from the snapshot with multiple Claude models", () => {
    const anthropic = getProvider("anthropic");
    expect(anthropic).toBeDefined();
    expect(anthropic!.setup).toBe("byok");
    expect(anthropic!.models.length).toBeGreaterThan(3);
    const ids = anthropic!.models.map((m) => m.id);
    expect(ids.some((id) => id.includes("claude"))).toBe(true);
  });

  it("includes openai from the snapshot with GPT models priced", () => {
    const openai = getProvider("openai");
    expect(openai).toBeDefined();
    const priced = openai!.models.filter((m) => m.pricing);
    expect(priced.length).toBeGreaterThan(0);
  });

  it("filters out providers without a bundled SDK (e.g. amazon-bedrock)", () => {
    expect(getProvider("amazon-bedrock")).toBeUndefined();
  });

  it("ends with openai-compatible (special, user-defined) provider", () => {
    expect(providers[providers.length - 1]?.id).toBe("openai-compatible");
  });

  it("exposes the new BYOK providers (xai, mistral, openrouter)", () => {
    for (const id of ["xai", "mistral", "openrouter"]) {
      const p = getProvider(id);
      expect(p, `expected provider ${id} to be in the registry`).toBeDefined();
      expect(p!.setup).toBe("byok");
      expect(p!.models.length).toBeGreaterThan(0);
      expect(p!.configSchema?.[0]?.key).toBe("apiKey");
    }
  });

  it("surfaces long-tail openai-compatible providers from models.dev", () => {
    // We surface every provider whose npm is in BUNDLED_PROVIDERS.
    // Any of these with an openai-compatible endpoint should appear.
    expect(providers.length).toBeGreaterThan(50);
    expect(getProvider("groq")).toBeDefined();
    expect(getProvider("deepseek")).toBeDefined();
  });

  it("hides deprecated and alpha/beta models by default", () => {
    const anthropic = getProvider("anthropic");
    const statuses = anthropic!.models.map((m) => m.status);
    expect(statuses.includes("deprecated")).toBe(false);
    expect(statuses.includes("alpha")).toBe(false);
    expect(statuses.includes("beta")).toBe(false);
  });
});

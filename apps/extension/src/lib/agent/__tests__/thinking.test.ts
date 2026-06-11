import { describe, expect, it } from "vitest";
import type { ThinkingConfig } from "../../types";
import {
  buildThinkingProviderOptions,
  isGemini3Model,
  isGeminiFlashModel,
  resolveThinkingVendor,
} from "../thinking";

const BUDGET: ThinkingConfig = { type: "budget", tokens: 12_000 };
const EFFORT_HIGH: ThinkingConfig = { type: "effort", level: "high" };

describe("resolveThinkingVendor", () => {
  it("maps direct providers to themselves", () => {
    expect(resolveThinkingVendor("anthropic", "claude-sonnet-4-6")).toBe(
      "anthropic",
    );
    expect(resolveThinkingVendor("google", "gemini-2.5-flash")).toBe("google");
    expect(resolveThinkingVendor("openai", "gpt-5.5")).toBe("openai");
  });

  it("derives vendor from the gateway model-id prefix", () => {
    expect(
      resolveThinkingVendor("vercel", "google/gemini-3.1-pro-preview"),
    ).toBe("google");
    expect(
      resolveThinkingVendor("vercel", "anthropic/claude-opus-4.7"),
    ).toBe("anthropic");
    expect(resolveThinkingVendor("vercel", "openai/gpt-5.5")).toBe("openai");
  });

  it("returns null for unknown providers / gateway vendors", () => {
    expect(resolveThinkingVendor("ollama", "llama-3")).toBeNull();
    expect(resolveThinkingVendor("vercel", "mistral/mistral-large")).toBeNull();
    expect(resolveThinkingVendor("vercel", "gemini-2.5-flash")).toBeNull();
  });
});

describe("isGemini3Model", () => {
  it("matches direct and gateway Gemini 3 ids", () => {
    expect(isGemini3Model("gemini-3.1-pro-preview")).toBe(true);
    expect(isGemini3Model("gemini-3.5-flash")).toBe(true);
    expect(isGemini3Model("google/gemini-3.1-pro-preview")).toBe(true);
  });

  it("does not match Gemini 2.5", () => {
    expect(isGemini3Model("gemini-2.5-flash")).toBe(false);
    expect(isGemini3Model("google/gemini-2.5-pro")).toBe(false);
  });
});

describe("isGeminiFlashModel", () => {
  it("detects flash variants across forms", () => {
    expect(isGeminiFlashModel("gemini-3.5-flash")).toBe(true);
    expect(isGeminiFlashModel("google/gemini-2.5-flash")).toBe(true);
    expect(isGeminiFlashModel("gemini-3.1-pro-preview")).toBe(false);
  });
});

describe("buildThinkingProviderOptions — Gemini", () => {
  it("Gemini 3 (direct) uses thinkingLevel + includeThoughts", () => {
    expect(
      buildThinkingProviderOptions(
        "google",
        "gemini-3.1-pro-preview",
        EFFORT_HIGH,
      ),
    ).toEqual({
      google: {
        thinkingConfig: { thinkingLevel: "high", includeThoughts: true },
      },
    });
  });

  it("Gemini 3 (gateway) uses thinkingLevel + includeThoughts", () => {
    expect(
      buildThinkingProviderOptions(
        "vercel",
        "google/gemini-3.1-pro-preview",
        EFFORT_HIGH,
      ),
    ).toEqual({
      google: {
        thinkingConfig: { thinkingLevel: "high", includeThoughts: true },
      },
    });
  });

  it("Gemini 3 falls back to medium level for legacy budget configs", () => {
    expect(
      buildThinkingProviderOptions(
        "google",
        "gemini-3.5-flash",
        BUDGET,
      ),
    ).toEqual({
      google: {
        thinkingConfig: { thinkingLevel: "medium", includeThoughts: true },
      },
    });
  });

  it("Gemini 2.5 (direct) uses thinkingBudget + includeThoughts", () => {
    expect(
      buildThinkingProviderOptions("google", "gemini-2.5-flash", BUDGET),
    ).toEqual({
      google: {
        thinkingConfig: { thinkingBudget: 12_000, includeThoughts: true },
      },
    });
  });

  it("Gemini 2.5 (gateway) uses thinkingBudget + includeThoughts", () => {
    expect(
      buildThinkingProviderOptions("vercel", "google/gemini-2.5-pro", BUDGET),
    ).toEqual({
      google: {
        thinkingConfig: { thinkingBudget: 12_000, includeThoughts: true },
      },
    });
  });
});

describe("buildThinkingProviderOptions — Anthropic", () => {
  it("budget config maps to adaptive/summarized thinking (direct)", () => {
    expect(
      buildThinkingProviderOptions("anthropic", "claude-opus-4-7", BUDGET),
    ).toEqual({
      anthropic: { thinking: { type: "adaptive", display: "summarized" } },
    });
  });

  it("effort config adds effort level (gateway)", () => {
    expect(
      buildThinkingProviderOptions(
        "vercel",
        "anthropic/claude-opus-4.7",
        EFFORT_HIGH,
      ),
    ).toEqual({
      anthropic: {
        thinking: { type: "adaptive", display: "summarized" },
        effort: "high",
      },
    });
  });
});

describe("buildThinkingProviderOptions — OpenAI", () => {
  it("effort config maps to nested reasoning.effort (direct)", () => {
    expect(
      buildThinkingProviderOptions("openai", "gpt-5.5", EFFORT_HIGH),
    ).toEqual({
      openai: { reasoning: { effort: "high" } },
    });
  });

  it("effort config maps to nested reasoning.effort (gateway)", () => {
    expect(
      buildThinkingProviderOptions("vercel", "openai/gpt-5.5", EFFORT_HIGH),
    ).toEqual({
      openai: { reasoning: { effort: "high" } },
    });
  });

  it("returns undefined for a budget config (OpenAI has no budget knob)", () => {
    expect(
      buildThinkingProviderOptions("openai", "gpt-5.5", BUDGET),
    ).toBeUndefined();
  });
});

describe("buildThinkingProviderOptions — unknown", () => {
  it("returns undefined when the vendor can't be resolved", () => {
    expect(
      buildThinkingProviderOptions("ollama", "llama-3", BUDGET),
    ).toBeUndefined();
  });
});

import { describe, expect, it } from "vitest";
import type { ThinkingConfig } from "../../types";
import {
  buildThinkingProviderOptions,
  isAnthropicAdaptiveThinkingModel,
  isGemini3Model,
  isGeminiFlashModel,
  isThinkingAlwaysOn,
  resolveThinkingProviderOptions,
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

describe("isAnthropicAdaptiveThinkingModel", () => {
  it("matches Sonnet/Opus 4.6+ and every 5.x family, in both id forms", () => {
    for (const id of [
      "claude-sonnet-4-6",
      "claude-opus-4-6",
      "claude-opus-4-7",
      "claude-opus-4-8",
      "claude-opus-5",
      "claude-sonnet-5",
      // From 5.x on the check is family-agnostic, so a family that isn't
      // adaptive at 4.x (Haiku) and one we've never seen both qualify.
      "claude-haiku-5",
      "claude-fable-5",
      "anthropic/claude-opus-4.7",
      "anthropic/claude-sonnet-4.6",
    ]) {
      expect(isAnthropicAdaptiveThinkingModel(id)).toBe(true);
    }
  });

  it("rejects pre-4.6 models, including dated ids", () => {
    for (const id of [
      "claude-sonnet-4-5",
      "claude-opus-4-5",
      "claude-haiku-4-5",
      // Boundary: family-agnostic detection starts at 5.x, so a 4.6 Haiku is
      // NOT assumed adaptive — Anthropic documents only Sonnet/Opus there.
      "claude-haiku-4-6",
      "claude-opus-4-1-20250805",
      "claude-opus-4-5-20251101",
      "anthropic/claude-opus-4.1",
      // Legacy version-first ids predate adaptive thinking entirely.
      "claude-3-opus-20240229",
    ]) {
      expect(isAnthropicAdaptiveThinkingModel(id)).toBe(false);
    }
  });

  it("rejects non-Claude models", () => {
    expect(isAnthropicAdaptiveThinkingModel("gpt-5.5")).toBe(false);
    expect(isAnthropicAdaptiveThinkingModel("gemini-3.1-pro-preview")).toBe(
      false,
    );
  });
});

describe("isThinkingAlwaysOn", () => {
  it("is true for Anthropic adaptive models, direct and via the gateway", () => {
    expect(isThinkingAlwaysOn("anthropic", "claude-opus-5")).toBe(true);
    expect(isThinkingAlwaysOn("vercel", "anthropic/claude-opus-4.7")).toBe(
      true,
    );
  });

  it("is false for pre-adaptive Anthropic models and other vendors", () => {
    expect(isThinkingAlwaysOn("anthropic", "claude-opus-4-5")).toBe(false);
    expect(isThinkingAlwaysOn("openai", "gpt-5.5")).toBe(false);
    expect(isThinkingAlwaysOn("google", "gemini-3.1-pro-preview")).toBe(false);
    // A Claude id reached through a provider we can't resolve to a vendor
    // isn't ours to force.
    expect(isThinkingAlwaysOn("openrouter", "anthropic/claude-opus-4.7")).toBe(
      false,
    );
  });
});

describe("resolveThinkingProviderOptions", () => {
  it("requests summarized thinking for an adaptive model even with the toggle OFF", () => {
    // The regression this fixes: with the toggle off we sent no `thinking`
    // field at all, so Anthropic applied its `display: "omitted"` default and
    // streamed thinking blocks with empty text — blank <Reasoning> blocks in
    // the transcript, for tokens the user paid for anyway.
    expect(
      resolveThinkingProviderOptions("anthropic", "claude-opus-5", {
        enabled: false,
      }),
    ).toEqual({
      anthropic: { thinking: { type: "adaptive", display: "summarized" } },
    });
  });

  it("forces it on when thinking settings are absent entirely (headless / MCP runs)", () => {
    expect(
      resolveThinkingProviderOptions("vercel", "anthropic/claude-opus-4.7"),
    ).toEqual({
      anthropic: { thinking: { type: "adaptive", display: "summarized" } },
    });
  });

  it("still honours an explicit effort level when the toggle is on", () => {
    expect(
      resolveThinkingProviderOptions("anthropic", "claude-opus-5", {
        enabled: true,
        config: EFFORT_HIGH,
      }),
    ).toEqual({
      anthropic: {
        thinking: { type: "adaptive", display: "summarized" },
        effort: "high",
      },
    });
  });

  it("returns undefined with the toggle off for models that are not always-on", () => {
    expect(
      resolveThinkingProviderOptions("openai", "gpt-5.5", { enabled: false }),
    ).toBeUndefined();
    expect(
      resolveThinkingProviderOptions("google", "gemini-2.5-flash"),
    ).toBeUndefined();
    expect(
      resolveThinkingProviderOptions("anthropic", "claude-opus-4-5"),
    ).toBeUndefined();
  });

  it("builds vendor defaults when enabled without a config", () => {
    // Previously the call sites gated on `enabled && config`, so an enabled
    // toggle with no persisted config silently sent nothing.
    expect(
      resolveThinkingProviderOptions("google", "gemini-2.5-flash", {
        enabled: true,
      }),
    ).toEqual({
      google: { thinkingConfig: { thinkingBudget: 8192, includeThoughts: true } },
    });
    expect(
      resolveThinkingProviderOptions("google", "gemini-3.1-pro-preview", {
        enabled: true,
      }),
    ).toEqual({
      google: { thinkingConfig: { thinkingLevel: "medium", includeThoughts: true } },
    });
  });
});

import { describe, expect, it } from "vitest";
import {
  isAnthropicComputerUseModel,
  isNewGenComputerUseModel,
  normalizeModelId,
} from "../model-ids";

describe("normalizeModelId", () => {
  it("strips an anthropic/ prefix and converts dot versions to hyphen", () => {
    expect(normalizeModelId("anthropic/claude-sonnet-4.6")).toBe(
      "claude-sonnet-4-6",
    );
  });

  it("leaves a direct hyphen id unchanged (lowercased)", () => {
    expect(normalizeModelId("claude-sonnet-4-6")).toBe("claude-sonnet-4-6");
  });
});

describe("isAnthropicComputerUseModel", () => {
  it("matches both direct and gateway forms of Sonnet 4.6", () => {
    expect(isAnthropicComputerUseModel("claude-sonnet-4-6")).toBe(true);
    expect(isAnthropicComputerUseModel("anthropic/claude-sonnet-4.6")).toBe(true);
  });

  it("matches Opus 4.5–4.8, Sonnet 4.5, Haiku 4.5 (both forms)", () => {
    for (const id of [
      "claude-opus-4-5",
      "anthropic/claude-opus-4.8",
      "claude-sonnet-4-5",
      "anthropic/claude-haiku-4.5",
    ]) {
      expect(isAnthropicComputerUseModel(id)).toBe(true);
    }
  });

  it("rejects non-CUA Claude models and non-Claude models", () => {
    expect(isAnthropicComputerUseModel("claude-opus-4-0")).toBe(false);
    expect(isAnthropicComputerUseModel("anthropic/claude-opus-4.1")).toBe(false);
    expect(isAnthropicComputerUseModel("openai/gpt-5.5")).toBe(false);
  });
});

describe("isNewGenComputerUseModel", () => {
  it("flags Sonnet 4.6 and Opus 4.5+ (both forms) as new-gen", () => {
    expect(isNewGenComputerUseModel("claude-sonnet-4-6")).toBe(true);
    expect(isNewGenComputerUseModel("anthropic/claude-sonnet-4.6")).toBe(true);
    expect(isNewGenComputerUseModel("anthropic/claude-opus-4.5")).toBe(true);
    expect(isNewGenComputerUseModel("claude-opus-4-8")).toBe(true);
  });

  it("treats Sonnet 4.5 and Haiku 4.5 as old-gen", () => {
    expect(isNewGenComputerUseModel("claude-sonnet-4-5")).toBe(false);
    expect(isNewGenComputerUseModel("anthropic/claude-haiku-4.5")).toBe(false);
  });
});

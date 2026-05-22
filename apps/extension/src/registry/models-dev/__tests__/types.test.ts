import { describe, it, expect } from "vitest";
import {
  ModelsDevCatalogSchema,
  ModelsDevModelSchema,
  ModelsDevProviderSchema,
} from "../types";

describe("models.dev schemas", () => {
  it("parses a minimal valid model", () => {
    const parsed = ModelsDevModelSchema.parse({
      id: "claude-haiku-4-5",
      name: "Claude Haiku 4.5",
      release_date: "2025-10-15",
      limit: { context: 200_000, output: 64_000 },
      cost: { input: 1, output: 5 },
      modalities: { input: ["text", "image"], output: ["text"] },
      tool_call: true,
      reasoning: true,
      attachment: true,
    });
    expect(parsed.id).toBe("claude-haiku-4-5");
    expect(parsed.cost?.input).toBe(1);
  });

  it("parses a minimal valid provider", () => {
    const parsed = ModelsDevProviderSchema.parse({
      id: "anthropic",
      name: "Anthropic",
      npm: "@ai-sdk/anthropic",
      env: ["ANTHROPIC_API_KEY"],
      models: {
        "claude-haiku-4-5": {
          id: "claude-haiku-4-5",
          name: "Claude Haiku 4.5",
          limit: { context: 200_000, output: 64_000 },
        },
      },
    });
    expect(parsed.id).toBe("anthropic");
    expect(Object.keys(parsed.models)).toHaveLength(1);
  });

  it("accepts unknown future fields without rejecting", () => {
    const parsed = ModelsDevProviderSchema.parse({
      id: "x",
      name: "X",
      env: [],
      models: {},
      future_field: "ok",
    });
    // passthrough preserves unknown fields
    expect((parsed as Record<string, unknown>).future_field).toBe("ok");
  });

  it("parses an empty catalog", () => {
    expect(ModelsDevCatalogSchema.parse({})).toEqual({});
  });
});

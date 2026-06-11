import { describe, expect, it } from "vitest";
import { resolveCuaProvider } from "../resolve";

describe("resolveCuaProvider", () => {
  it("resolves the direct Anthropic provider with an apiKey", () => {
    const p = resolveCuaProvider("anthropic", "claude-sonnet-4-6", {
      apiKey: "sk-test",
    });
    expect(p).toBeDefined();
    expect(typeof p.runLoop).toBe("function");
  });

  it("throws for direct Anthropic without an apiKey", () => {
    expect(() => resolveCuaProvider("anthropic", "claude-sonnet-4-6", {})).toThrow(
      /apiKey/i,
    );
  });

  it("resolves the gateway (vercel) provider for a Claude CUA model", () => {
    const p = resolveCuaProvider("vercel", "anthropic/claude-sonnet-4.6", {
      apiKey: "gw-test",
    });
    expect(p).toBeDefined();
    expect(typeof p.runLoop).toBe("function");
  });

  it("throws for the gateway with a non-Claude model", () => {
    expect(() =>
      resolveCuaProvider("vercel", "openai/gpt-5.5", { apiKey: "gw-test" }),
    ).toThrow(/Anthropic Claude computer-use model/i);
  });

  it("throws for the gateway with a non-CUA Claude model", () => {
    expect(() =>
      resolveCuaProvider("vercel", "anthropic/claude-opus-4.1", {
        apiKey: "gw-test",
      }),
    ).toThrow(/Anthropic Claude computer-use model/i);
  });

  it("throws for an unsupported provider", () => {
    expect(() =>
      resolveCuaProvider("openai", "gpt-5.5", { apiKey: "sk" }),
    ).toThrow(/not supported/i);
  });
});

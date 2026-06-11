import { describe, expect, it } from "vitest";
import { providers } from "../../providers";

describe("computer-use capability flagging", () => {
  it("flags Sonnet 4.6 as computer-use when present in the catalog", () => {
    const anthropic = providers.find((p) => p.id === "anthropic");
    expect(anthropic).toBeDefined();
    const cua = anthropic?.models.find((m) => m.id === "claude-sonnet-4-6");
    // Only assert if the model is present in the bundled snapshot.
    if (cua) {
      expect(cua.capabilities).toContain("computer-use");
    }
  });

  it("does NOT flag a non-CUA model like claude-opus-4-0", () => {
    const anthropic = providers.find((p) => p.id === "anthropic");
    const nonCua = anthropic?.models.find((m) => m.id === "claude-opus-4-0");
    if (nonCua) {
      expect(nonCua.capabilities).not.toContain("computer-use");
    }
  });

  it("flags the gateway (vercel) Claude CUA model despite the anthropic/ prefix + dot version", () => {
    const vercel = providers.find((p) => p.id === "vercel");
    expect(vercel).toBeDefined();
    const cua = vercel?.models.find((m) => m.id === "anthropic/claude-sonnet-4.6");
    if (cua) {
      expect(cua.capabilities).toContain("computer-use");
    }
    // And a non-CUA gateway model must NOT be flagged.
    const nonCua = vercel?.models.find((m) => m.id === "anthropic/claude-opus-4.1");
    if (nonCua) {
      expect(nonCua.capabilities).not.toContain("computer-use");
    }
  });
});

import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";

describe("oauth/pkce", () => {
  it("S256 verification passes for matching verifier+challenge", async () => {
    const { verifyPkce } = await import("../pkce");
    const verifier = "JQ614BIdZdAVgEtlgHKpYo_YfNrnApkck2UvvxI7fBE";
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    expect(verifyPkce(verifier, challenge, "S256")).toBe(true);
  });

  it("S256 verification fails for mismatched verifier", async () => {
    const { verifyPkce } = await import("../pkce");
    const verifier = "wrong";
    const challenge = createHash("sha256").update("right").digest("base64url");
    expect(verifyPkce(verifier, challenge, "S256")).toBe(false);
  });

  it("rejects 'plain' method (PKCE-S256 only per MCP spec)", async () => {
    const { verifyPkce } = await import("../pkce");
    expect(verifyPkce("x", "x", "plain")).toBe(false);
  });

  it("rejects unknown methods", async () => {
    const { verifyPkce } = await import("../pkce");
    expect(verifyPkce("x", "x", "S512")).toBe(false);
  });
});

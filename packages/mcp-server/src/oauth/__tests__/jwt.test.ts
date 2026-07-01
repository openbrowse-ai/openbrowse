import { describe, expect, it, beforeAll } from "vitest";
import { generateKeyPairSync, KeyObject } from "node:crypto";

describe("oauth/jwt", () => {
  let publicKey: KeyObject;
  let privateKey: KeyObject;

  beforeAll(() => {
    const kp = generateKeyPairSync("ed25519");
    publicKey = kp.publicKey;
    privateKey = kp.privateKey;
  });

  it("mints a JWT that round-trips through verifyJwt", async () => {
    const { mintJwt, verifyJwt } = await import("../jwt");
    const now = Math.floor(Date.now() / 1000);
    const token = mintJwt(privateKey, "kid1", {
      iss: "http://localhost:47821",
      aud: "http://localhost:47821/mcp",
      sub: "client_x",
      scope: "task read_page",
      iat: now,
      exp: now + 60,
    });
    const result = verifyJwt(token, publicKey, { audience: "http://localhost:47821/mcp" });
    expect(result.valid).toBe(true);
    if (!result.valid) throw new Error("unreachable");
    expect(result.payload.sub).toBe("client_x");
    expect(result.payload.scope).toBe("task read_page");
    const headerJson = JSON.parse(
      Buffer.from(token.split(".")[0], "base64url").toString("utf8"),
    );
    expect(headerJson).toEqual({ alg: "EdDSA", typ: "JWT", kid: "kid1" });
  });

  it("rejects expired tokens", async () => {
    const { mintJwt, verifyJwt } = await import("../jwt");
    const past = Math.floor(Date.now() / 1000) - 100;
    const token = mintJwt(privateKey, "kid1", {
      iss: "http://localhost:47821",
      aud: "http://localhost:47821/mcp",
      sub: "x",
      iat: past - 100,
      exp: past,
    });
    const result = verifyJwt(token, publicKey, { audience: "http://localhost:47821/mcp" });
    expect(result.valid).toBe(false);
    if (result.valid) throw new Error("unreachable");
    expect(result.reason).toBe("expired");
  });

  it("rejects wrong audience", async () => {
    const { mintJwt, verifyJwt } = await import("../jwt");
    const now = Math.floor(Date.now() / 1000);
    const token = mintJwt(privateKey, "kid1", {
      iss: "http://localhost:47821",
      aud: "http://localhost:47821/mcp",
      sub: "x",
      iat: now,
      exp: now + 60,
    });
    const result = verifyJwt(token, publicKey, { audience: "http://localhost:47821/other" });
    expect(result.valid).toBe(false);
    if (result.valid) throw new Error("unreachable");
    expect(result.reason).toBe("wrong_audience");
  });

  it("rejects tampered tokens (bad signature)", async () => {
    const { mintJwt, verifyJwt } = await import("../jwt");
    const now = Math.floor(Date.now() / 1000);
    let token = mintJwt(privateKey, "kid1", {
      iss: "http://localhost:47821",
      aud: "http://localhost:47821/mcp",
      sub: "x",
      iat: now,
      exp: now + 60,
    });
    // Flip a byte in the signature segment
    const parts = token.split(".");
    const sigBytes = Buffer.from(parts[2].replace(/-/g, "+").replace(/_/g, "/"), "base64");
    sigBytes[0] ^= 0x01;
    parts[2] = sigBytes.toString("base64url");
    token = parts.join(".");
    const result = verifyJwt(token, publicKey, { audience: "http://localhost:47821/mcp" });
    expect(result.valid).toBe(false);
    if (result.valid) throw new Error("unreachable");
    expect(result.reason).toBe("bad_signature");
  });

  it("rejects malformed tokens", async () => {
    const { verifyJwt } = await import("../jwt");
    const result = verifyJwt("not.a.jwt.really", publicKey, { audience: "x" });
    expect(result.valid).toBe(false);
    if (result.valid) throw new Error("unreachable");
    expect(result.reason).toBe("malformed");
  });
});

import { describe, expect, it } from "vitest";
import { generateKeyPairSync } from "node:crypto";

describe("routes/jwks", () => {
  it("produces a JWK with Ed25519 OKP key type from broker keypair", async () => {
    const { publicKey } = generateKeyPairSync("ed25519");
    const { buildJwks } = await import("../jwks");
    const result = buildJwks(publicKey, "test-kid");
    expect(result.keys).toHaveLength(1);
    expect(result.keys[0].kty).toBe("OKP");
    expect(result.keys[0].crv).toBe("Ed25519");
    expect(result.keys[0].alg).toBe("EdDSA");
    expect(result.keys[0].kid).toBe("test-kid");
    expect(typeof result.keys[0].x).toBe("string");
    expect(result.keys[0].x.length).toBeGreaterThan(0);
    expect(Buffer.from(result.keys[0].x, "base64url")).toHaveLength(32);
  });
});

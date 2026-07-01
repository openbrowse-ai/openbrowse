import { describe, expect, it } from "vitest";
import { generateKeyPairSync, createHash } from "node:crypto";

async function setup() {
  const { handleArtifact } = await import("../artifact");
  const { mintJwt } = await import("../../oauth/jwt");
  const { createArtifactStore } = await import("../../artifacts/store");
  const kp = generateKeyPairSync("ed25519");
  const cfg = {
    port: 47821,
    issuer: "http://localhost:47821",
    resource: "http://localhost:47821/mcp",
  };
  const fingerprint = createHash("sha256")
    .update(kp.publicKey.export({ type: "spki", format: "der" }) as Buffer)
    .digest("hex")
    .slice(0, 16);
  const store = createArtifactStore();
  return { handleArtifact, mintJwt, kp, cfg, fingerprint, store };
}

function tokenFor(t: Awaited<ReturnType<typeof setup>>, sub: string): string {
  const now = Math.floor(Date.now() / 1000);
  return t.mintJwt(t.kp.privateKey, t.fingerprint, {
    iss: t.cfg.issuer,
    aud: t.cfg.resource,
    sub,
    iat: now,
    exp: now + 60,
  });
}

describe("routes/artifact", () => {
  it("returns 401 without a bearer", async () => {
    const t = await setup();
    const result = await t.handleArtifact({
      id: "x",
      headers: {},
      cfg: t.cfg,
      publicKey: t.kp.publicKey,
      store: t.store,
    });
    expect(result.status).toBe(401);
  });

  it("returns 404 for unknown artifact id", async () => {
    const t = await setup();
    const result = await t.handleArtifact({
      id: "nonexistent",
      headers: { authorization: `Bearer ${tokenFor(t, "c1")}` },
      cfg: t.cfg,
      publicKey: t.kp.publicKey,
      store: t.store,
    });
    expect(result.status).toBe(404);
  });

  it("returns bytes with correct Content-Type for a stored artifact", async () => {
    const t = await setup();
    const id = t.store.put({
      ownerClientId: "c1",
      contentType: "image/png",
      bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      filename: "page.png",
    });
    const result = await t.handleArtifact({
      id,
      headers: { authorization: `Bearer ${tokenFor(t, "c1")}` },
      cfg: t.cfg,
      publicKey: t.kp.publicKey,
      store: t.store,
    });
    expect(result.status).toBe(200);
    expect(result.headers["content-type"]).toBe("image/png");
    expect(result.headers["content-disposition"]).toContain("page.png");
    expect(result.bodyBytes?.equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))).toBe(true);
  });

  it("forbids cross-client artifact access (404 not 403 to avoid id enumeration)", async () => {
    const t = await setup();
    const id = t.store.put({
      ownerClientId: "c1",
      contentType: "text/plain",
      bytes: Buffer.from("secret"),
    });
    const result = await t.handleArtifact({
      id,
      headers: { authorization: `Bearer ${tokenFor(t, "c2_different_client")}` },
      cfg: t.cfg,
      publicKey: t.kp.publicKey,
      store: t.store,
    });
    expect(result.status).toBe(404);
  });

  it("strips control chars from filename to prevent header injection", async () => {
    const t = await setup();
    const id = t.store.put({
      ownerClientId: "c1",
      contentType: "text/plain",
      bytes: Buffer.from("ok"),
      filename: 'evil\r\nX-Injected: yes"name.txt',
    });
    const result = await t.handleArtifact({
      id,
      headers: { authorization: `Bearer ${tokenFor(t, "c1")}` },
      cfg: t.cfg,
      publicKey: t.kp.publicKey,
      store: t.store,
    });
    expect(result.status).toBe(200);
    const cd = result.headers["content-disposition"];
    expect(cd).toBeDefined();
    // The control chars and quotes must be gone:
    expect(cd).not.toMatch(/[\r\n\x00-\x1f]/);
    expect(cd).not.toContain('"name.txt"'); // The injected `"` was stripped
    // The benign portion of the filename survives:
    expect(cd).toContain("evilX-Injected: yesname.txt");
  });
});

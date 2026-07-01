import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("keys/store", () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), "obx-mcp-keys-"));
    vi.stubEnv("HOME", tmpHome);
  });

  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true });
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("generates a keypair on first read and persists it", async () => {
    const { loadOrCreateKeyPair } = await import("../store");
    const first = await loadOrCreateKeyPair();
    expect(first.publicKey).toBeDefined();
    expect(first.privateKey).toBeDefined();
    expect(first.fingerprint).toMatch(/^[0-9a-f]{16}$/);
    expect(existsSync(join(tmpHome, ".openbrowse", "broker-key.json"))).toBe(true);
  });

  it("returns the same keypair on subsequent reads", async () => {
    const { loadOrCreateKeyPair } = await import("../store");
    const first = await loadOrCreateKeyPair();
    const second = await loadOrCreateKeyPair();
    expect(second.fingerprint).toBe(first.fingerprint);
  });

  it("writes the key file with mode 0600", async () => {
    const { loadOrCreateKeyPair } = await import("../store");
    await loadOrCreateKeyPair();
    const { statSync } = await import("node:fs");
    const mode = statSync(join(tmpHome, ".openbrowse", "broker-key.json")).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("rotate-keys", () => {
  let tmpHome: string;
  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), "obx-rotate-"));
    vi.stubEnv("HOME", tmpHome);
    vi.resetModules();
  });
  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true });
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("rotateKeyPair backs up the previous key + generates a new one", async () => {
    const { loadOrCreateKeyPair, rotateKeyPair } = await import("../../keys/store");
    const first = await loadOrCreateKeyPair();
    const second = await rotateKeyPair();
    expect(second.fingerprint).not.toBe(first.fingerprint);
    expect(existsSync(join(tmpHome, ".openbrowse", "broker-key.previous.json"))).toBe(true);
    expect(existsSync(join(tmpHome, ".openbrowse", "broker-key.json"))).toBe(true);
  });

  it("rotateKeyPair tolerates a missing existing key (first-run rotation is a noop-backup)", async () => {
    const { rotateKeyPair } = await import("../../keys/store");
    // No prior loadOrCreateKeyPair call → no existing broker-key.json
    const kp = await rotateKeyPair();
    expect(kp.fingerprint).toMatch(/^[0-9a-f]{16}$/);
    // No previous file should have been created since there was nothing to back up
    expect(existsSync(join(tmpHome, ".openbrowse", "broker-key.previous.json"))).toBe(false);
    expect(existsSync(join(tmpHome, ".openbrowse", "broker-key.json"))).toBe(true);
  });
});

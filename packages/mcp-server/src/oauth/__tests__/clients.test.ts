import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("oauth/clients", () => {
  let tmpHome: string;
  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), "obx-clients-"));
    vi.stubEnv("HOME", tmpHome);
    vi.resetModules();
  });
  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true });
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  it("registers a client with redirect_uris and returns a client_id", async () => {
    const { createClientRegistry } = await import("../clients");
    const reg = createClientRegistry();
    const result = reg.register({
      client_name: "Test Client",
      redirect_uris: ["http://127.0.0.1:9999/callback"],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(typeof result.client.client_id).toBe("string");
      expect(result.client.client_name).toBe("Test Client");
      expect(result.client.redirect_uris).toEqual(["http://127.0.0.1:9999/callback"]);
    }
  });

  it("rejects registration with no redirect_uris", async () => {
    const { createClientRegistry } = await import("../clients");
    const reg = createClientRegistry();
    const result = reg.register({ client_name: "X", redirect_uris: [] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("invalid_redirect_uri");
  });

  it("lookup by client_id returns the registered client", async () => {
    const { createClientRegistry } = await import("../clients");
    const reg = createClientRegistry();
    const r = reg.register({ client_name: "C", redirect_uris: ["http://localhost:8080/cb"] });
    if (!r.ok) throw new Error("setup");
    const found = reg.get(r.client.client_id);
    expect(found?.client_name).toBe("C");
  });

  it("lookup of unknown client_id returns undefined", async () => {
    const { createClientRegistry } = await import("../clients");
    const reg = createClientRegistry();
    expect(reg.get("missing")).toBeUndefined();
  });

  it("persists registrations across registry recreations (broker restarts)", async () => {
    const { createClientRegistry } = await import("../clients");
    const regA = createClientRegistry();
    const r = regA.register({
      client_name: "Survivor",
      redirect_uris: ["http://127.0.0.1:1234/cb"],
    });
    if (!r.ok) throw new Error("setup");

    // Simulate a broker restart: fresh module, fresh registry, same $HOME.
    vi.resetModules();
    const { createClientRegistry: recreate } = await import("../clients");
    const regB = recreate();
    const found = regB.get(r.client.client_id);
    expect(found?.client_name).toBe("Survivor");
    expect(found?.redirect_uris).toEqual(["http://127.0.0.1:1234/cb"]);
  });

  it("writes clients.json with 0600 and ~/.openbrowse with 0700", async () => {
    const { createClientRegistry } = await import("../clients");
    const reg = createClientRegistry();
    reg.register({ redirect_uris: ["http://127.0.0.1:1/cb"] });
    const file = join(tmpHome, ".openbrowse", "clients.json");
    expect(existsSync(file)).toBe(true);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(join(tmpHome, ".openbrowse")).mode & 0o777).toBe(0o700);
  });

  it("tightens a pre-existing ~/.openbrowse dir with loose permissions to 0700", async () => {
    // Simulates a dir created by an older install (or default umask 022).
    mkdirSync(join(tmpHome, ".openbrowse"), { recursive: true, mode: 0o755 });
    expect(statSync(join(tmpHome, ".openbrowse")).mode & 0o777).toBe(0o755);
    const { createClientRegistry } = await import("../clients");
    const reg = createClientRegistry();
    reg.register({ redirect_uris: ["http://127.0.0.1:1/cb"] });
    expect(statSync(join(tmpHome, ".openbrowse")).mode & 0o777).toBe(0o700);
  });

  it("evicts least-recently-used clients beyond the cap", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-01T00:00:00Z"));
    const { createClientRegistry } = await import("../clients");
    const reg = createClientRegistry();
    const ids: string[] = [];
    for (let i = 0; i < 505; i++) {
      // Distinct timestamps so LRU ordering is deterministic.
      vi.advanceTimersByTime(1000);
      const r = reg.register({ redirect_uris: [`http://127.0.0.1:${i + 1}/cb`] });
      if (!r.ok) throw new Error("setup");
      ids.push(r.client.client_id);
    }
    // Oldest 5 evicted; newest 500 retained.
    for (let i = 0; i < 5; i++) expect(reg.get(ids[i]!)).toBeUndefined();
    for (let i = 5; i < 505; i++) expect(reg.get(ids[i]!)).toBeDefined();
  });

  it("touch() refreshes last_used_at so touched clients survive eviction", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-01T00:00:00Z"));
    const { createClientRegistry } = await import("../clients");
    const reg = createClientRegistry();
    const first = reg.register({ redirect_uris: ["http://127.0.0.1:1/cb"] });
    if (!first.ok) throw new Error("setup");
    // Fill to the cap; `first` is now the LRU candidate...
    for (let i = 0; i < 499; i++) {
      vi.advanceTimersByTime(1000);
      const r = reg.register({ redirect_uris: [`http://127.0.0.1:${i + 2}/cb`] });
      if (!r.ok) throw new Error("setup");
    }
    // ...unless it gets touched (successful authorize) before overflow.
    vi.advanceTimersByTime(1000);
    reg.touch(first.client.client_id);
    vi.advanceTimersByTime(1000);
    const overflow = reg.register({ redirect_uris: ["http://127.0.0.1:9999/cb"] });
    if (!overflow.ok) throw new Error("setup");
    expect(reg.get(first.client.client_id)).toBeDefined();
  });

  it("starts empty (without crashing) when clients.json is corrupt", async () => {
    mkdirSync(join(tmpHome, ".openbrowse"), { recursive: true });
    writeFileSync(join(tmpHome, ".openbrowse", "clients.json"), "{not json!!");
    const { createClientRegistry } = await import("../clients");
    const reg = createClientRegistry();
    expect(reg.get("anything")).toBeUndefined();
    // Registry still functions: a new registration overwrites the bad file.
    const r = reg.register({ redirect_uris: ["http://127.0.0.1:1/cb"] });
    expect(r.ok).toBe(true);
    const raw = readFileSync(join(tmpHome, ".openbrowse", "clients.json"), "utf8");
    expect(() => JSON.parse(raw)).not.toThrow();
  });

  it("starts empty when clients.json has an unknown schema version", async () => {
    mkdirSync(join(tmpHome, ".openbrowse"), { recursive: true });
    writeFileSync(
      join(tmpHome, ".openbrowse", "clients.json"),
      JSON.stringify({ version: 99, clients: { x: {} } }),
    );
    const { createClientRegistry } = await import("../clients");
    const reg = createClientRegistry();
    expect(reg.get("x")).toBeUndefined();
  });
});

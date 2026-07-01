import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(() => {
  const store: Record<string, unknown> = {};
  (globalThis as any).chrome = {
    storage: {
      local: {
        get: vi.fn(async (key: string) => ({ [key]: store[key] })),
        set: vi.fn(async (obj: Record<string, unknown>) => Object.assign(store, obj)),
      },
    },
  };
  (globalThis as any).__store = store;
});

afterEach(() => {
  delete (globalThis as any).chrome;
  delete (globalThis as any).__store;
  vi.resetModules();
});

describe("mcp-host-policy", () => {
  it("getPolicy defaults unknown clients to auto-allow", async () => {
    const { getPolicy } = await import("@/lib/mcp-host-policy");
    expect(await getPolicy("unknown-client")).toBe("auto-allow");
  });

  it("setPolicy / getPolicy round-trip", async () => {
    const { setPolicy, getPolicy } = await import("@/lib/mcp-host-policy");
    await setPolicy("c1", "auto-allow");
    expect(await getPolicy("c1")).toBe("auto-allow");
    await setPolicy("c2", "blocked");
    expect(await getPolicy("c2")).toBe("blocked");
  });

  it("listPolicies returns all stored client → policy mappings", async () => {
    const { setPolicy, listPolicies } = await import("@/lib/mcp-host-policy");
    await setPolicy("c1", "auto-allow");
    await setPolicy("c2", "always-prompt");
    const list = await listPolicies();
    expect(list).toEqual({ c1: "auto-allow", c2: "always-prompt" });
  });

  describe("resolveConfirmation", () => {
    it("blocked user policy beats everything", async () => {
      const { setPolicy, resolveConfirmation } = await import("@/lib/mcp-host-policy");
      await setPolicy("c1", "blocked");
      expect(await resolveConfirmation("c1", "auto")).toBe("host_blocked");
      expect(await resolveConfirmation("c1", "prompt")).toBe("host_blocked");
    });

    it("auto-allow + host auto → allow without prompt", async () => {
      const { setPolicy, resolveConfirmation } = await import("@/lib/mcp-host-policy");
      await setPolicy("c1", "auto-allow");
      expect(await resolveConfirmation("c1", "auto")).toBe("auto");
    });

    it("auto-allow + host prompt → prompt (more friction wins)", async () => {
      const { setPolicy, resolveConfirmation } = await import("@/lib/mcp-host-policy");
      await setPolicy("c1", "auto-allow");
      expect(await resolveConfirmation("c1", "prompt")).toBe("prompt");
    });

    it("always-prompt → always prompt regardless of host request", async () => {
      const { setPolicy, resolveConfirmation } = await import("@/lib/mcp-host-policy");
      await setPolicy("c1", "always-prompt");
      expect(await resolveConfirmation("c1", "auto")).toBe("prompt");
      expect(await resolveConfirmation("c1", "prompt")).toBe("prompt");
    });

    it("unknown client (auto-allow default) + host auto → allow without prompt", async () => {
      // Regression guard for the 2026-06-29 default-policy flip. The
      // previous default was `always-prompt` (fail-closed); after the
      // OAuth-is-consent UX overhaul it became `auto-allow`. Flipping it
      // back would silently surface per-action prompts on every host
      // call, which is the bug the overhaul fixed.
      const { resolveConfirmation } = await import("@/lib/mcp-host-policy");
      expect(await resolveConfirmation("c1", "auto")).toBe("auto");
    });

    it("unknown client + host prompt → prompt (host opt-in still works)", async () => {
      const { resolveConfirmation } = await import("@/lib/mcp-host-policy");
      expect(await resolveConfirmation("c1", "prompt")).toBe("prompt");
    });

    it("falls through to default behavior on a corrupt stored policy value", async () => {
      // Post-default-flip semantics: a garbage stored value behaves
      // like an absent value (i.e. auto-allow + host-request respected).
      // The pre-flip test asserted fail-closed because the default
      // itself was fail-closed; now the default trusts the OAuth grant.
      const { resolveConfirmation } = await import("@/lib/mcp-host-policy");
      await chrome.storage.local.set({ mcp_host_policies: { c1: "garbage_value" } });
      expect(await resolveConfirmation("c1", "auto")).toBe("auto");
      expect(await resolveConfirmation("c1", "prompt")).toBe("prompt");
    });
  });
});

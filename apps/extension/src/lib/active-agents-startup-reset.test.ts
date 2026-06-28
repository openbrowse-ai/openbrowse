import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Regression for the post-Chrome-restart "Stop button stuck" bug.
 *
 * `setAgentActive` persists conversation ids to `chrome.storage.local`
 * so the sidebar "running" dot survives renderer reloads. But the
 * matching `setAgentInactive` only fires from the renderer's
 * `useChat.onFinish` (and the status-change effect's terminal
 * branch). Renderer death (Chrome quit, extension reload, tab crash)
 * bypasses both, leaking the flag.
 *
 * Post-restart symptom: `isAgentActiveGlobally` stays true, so
 * `ChatView` computes `isLoading = true`, the composer renders the
 * Stop button, and `useChat.stop()` is inert because there's no
 * active stream to abort.
 *
 * `resetActiveAgentsAtStartup` is the SW-boot defensive sweep: a fresh
 * SW process has zero live runs in its in-memory registry, so ANY
 * persisted id at boot is necessarily stale.
 */

function makeAsyncStorage() {
  const data: Record<string, unknown> = {};
  return {
    store: data,
    local: {
      get: vi.fn((key: string) =>
        Promise.resolve().then(() => ({ [key]: data[key] })),
      ),
      set: vi.fn((obj: Record<string, unknown>) =>
        Promise.resolve().then(() => {
          Object.assign(data, obj);
        }),
      ),
      remove: vi.fn(() => Promise.resolve()),
    },
    onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
  };
}

describe("resetActiveAgentsAtStartup", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("clears all entries when the storage list is non-empty", async () => {
    const storage = makeAsyncStorage();
    storage.store["active-agents"] = ["conv-A", "conv-B", "conv-C"];
    vi.stubGlobal("chrome", { storage });

    const { resetActiveAgentsAtStartup, getActiveAgents } = await import(
      "./active-agents"
    );

    await resetActiveAgentsAtStartup();

    expect(await getActiveAgents()).toEqual([]);
  });

  it("is a no-op when storage already has no entries", async () => {
    const storage = makeAsyncStorage();
    vi.stubGlobal("chrome", { storage });

    const { resetActiveAgentsAtStartup, getActiveAgents } = await import(
      "./active-agents"
    );

    await resetActiveAgentsAtStartup();
    expect(await getActiveAgents()).toEqual([]);
  });

  it("is idempotent — running twice leaves the list empty without throwing", async () => {
    const storage = makeAsyncStorage();
    storage.store["active-agents"] = ["conv-A"];
    vi.stubGlobal("chrome", { storage });

    const { resetActiveAgentsAtStartup, getActiveAgents } = await import(
      "./active-agents"
    );

    await resetActiveAgentsAtStartup();
    await expect(resetActiveAgentsAtStartup()).resolves.toBeUndefined();
    expect(await getActiveAgents()).toEqual([]);
  });

  it("a `setAgentActive` issued immediately after reset wins (queue ordering)", async () => {
    // The reset and a fresh activation MUST serialize through the
    // module's `enqueueMutation` queue. If the reset's set() raced
    // ahead of a same-tick `setAgentActive`, a port-driven run that
    // started while reset was in flight would be wiped immediately
    // after being added.
    const storage = makeAsyncStorage();
    storage.store["active-agents"] = ["stale-conv"];
    vi.stubGlobal("chrome", { storage });

    const { resetActiveAgentsAtStartup, setAgentActive, getActiveAgents } =
      await import("./active-agents");

    // Reset enqueued FIRST, then setAgentActive enqueued. Both
    // promises pending in the queue together.
    const resetPromise = resetActiveAgentsAtStartup();
    const setPromise = setAgentActive("fresh-conv");

    await Promise.all([resetPromise, setPromise]);

    const final = await getActiveAgents();
    expect(final).toEqual(["fresh-conv"]);
    expect(final).not.toContain("stale-conv");
  });

  it("a stale `setAgentInactive` for an unknown conv during/after reset is harmless", async () => {
    // Defensive: a renderer that died with a stranded run could,
    // immediately on rehydration, issue a setAgentInactive for a
    // conversation that the reset just cleared. That must be a
    // no-op, not throw, not re-introduce the id.
    const storage = makeAsyncStorage();
    storage.store["active-agents"] = ["stale-conv"];
    vi.stubGlobal("chrome", { storage });

    const { resetActiveAgentsAtStartup, setAgentInactive, getActiveAgents } =
      await import("./active-agents");

    await resetActiveAgentsAtStartup();
    await expect(setAgentInactive("stale-conv")).resolves.toBeUndefined();

    expect(await getActiveAgents()).toEqual([]);
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

// Reproduces the hypothesized concurrent read-modify-write race in
// active-agents.ts. A realistic chrome.storage.local backend resolves get/set
// asynchronously (microtask), so two overlapping mutations can read the same
// snapshot and the later set() clobbers the earlier one.

function makeAsyncStorage() {
  const data: Record<string, unknown> = {};
  return {
    store: data,
    local: {
      get: vi.fn((key: string) =>
        // Resolve on a microtask, mimicking real async storage. This is what
        // creates the interleaving window between two callers.
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

describe("active-agents concurrent mutation race", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("keeps both ids when two setAgentActive calls overlap", async () => {
    const storage = makeAsyncStorage();
    vi.stubGlobal("chrome", { storage });

    const { setAgentActive, getActiveAgents } = await import("./active-agents");

    // Fire two activations "simultaneously" (no await between) — exactly the
    // scenario when the visible chat and the hidden scheduled run both flip to
    // streaming at about the same time.
    await Promise.all([setAgentActive("chat-A"), setAgentActive("sched-run-1")]);

    const result = await getActiveAgents();
    expect(result).toContain("chat-A");
    expect(result).toContain("sched-run-1");
  });

  it("keeps the run id when an unrelated chat goes inactive concurrently", async () => {
    const storage = makeAsyncStorage();
    storage.store["active-agents"] = ["chat-A"];
    vi.stubGlobal("chrome", { storage });

    const { setAgentActive, setAgentInactive, getActiveAgents } = await import(
      "./active-agents"
    );

    // The visible chat finishes (clears its id) at the same instant the
    // background scheduled run starts (sets its id). The run id must survive.
    await Promise.all([
      setAgentInactive("chat-A"),
      setAgentActive("sched-run-1"),
    ]);

    const result = await getActiveAgents();
    expect(result).toContain("sched-run-1");
  });
});

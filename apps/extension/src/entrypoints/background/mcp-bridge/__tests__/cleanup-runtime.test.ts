import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanupTaskTabs,
  collectRowsToClean,
  type CleanupTaskTabsDeps,
  type TabCleanupPolicy,
} from "../cleanup-runtime";
// `sweepOrphanedMcpTasks` is imported dynamically inside each test
// via `await import("../cleanup-runtime")` so that fake-indexeddb
// setup can complete before the module reads chatDb — a static
// import here would resolve before those hooks run.

/**
 * Orchestrator + runtime helpers. Dependency-injected so the tests
 * never touch chrome.* or chat-db.
 */

function makeDeps(overrides: Partial<CleanupTaskTabsDeps> = {}): {
  deps: CleanupTaskTabsDeps;
  spies: {
    closeOwnedTabs: ReturnType<typeof vi.fn>;
    broadcast: ReturnType<typeof vi.fn>;
    removeWindow: ReturnType<typeof vi.fn>;
    getSettings: ReturnType<typeof vi.fn>;
    getConversationOwnedLtids: ReturnType<typeof vi.fn>;
    listDescendantConversationIds: ReturnType<typeof vi.fn>;
  };
} {
  const closeOwnedTabs = vi.fn(async () => ({
    action: "reopen" as const,
    id: "undo-1",
    tabs: [],
  }));
  const broadcast = vi.fn(async () => undefined);
  const removeWindow = vi.fn(async () => undefined);
  const getSettings = vi.fn(async () => ({
    mcpAfterTaskTabPolicy: "always-close" as TabCleanupPolicy,
  }));
  // Default: parent has two owned ltids, no descendants.
  const getConversationOwnedLtids = vi.fn(async () => ["ltid-a", "ltid-b"]);
  const listDescendantConversationIds = vi.fn(async () => [] as string[]);
  return {
    deps: {
      closeOwnedTabs,
      broadcast,
      removeWindow,
      getSettings,
      getConversationOwnedLtids,
      listDescendantConversationIds,
      ...overrides,
    },
    spies: {
      closeOwnedTabs,
      broadcast,
      removeWindow,
      getSettings,
      getConversationOwnedLtids,
      listDescendantConversationIds,
    },
  };
}

const baseTask = {
  taskId: "t1",
  conversationId: "conv-1",
  createdWindowId: undefined as number | undefined,
};

describe("cleanup-runtime — cleanupTaskTabs (orchestrator)", () => {
  it("no-ops on 'keep' policy: does not close tabs, broadcast, or remove window", async () => {
    const { deps, spies } = makeDeps({
      getSettings: vi.fn(async () => ({
        mcpAfterTaskTabPolicy: "keep" as TabCleanupPolicy,
      })),
    });
    await cleanupTaskTabs(
      { ...baseTask, createdWindowId: 42 },
      "completed",
      deps,
    );
    expect(spies.closeOwnedTabs).not.toHaveBeenCalled();
    expect(spies.broadcast).not.toHaveBeenCalled();
    expect(spies.removeWindow).not.toHaveBeenCalled();
  });

  it("no-ops on 'close-on-cancel-only' + completed: does not close", async () => {
    const { deps, spies } = makeDeps({
      getSettings: vi.fn(async () => ({
        mcpAfterTaskTabPolicy: "close-on-cancel-only" as TabCleanupPolicy,
      })),
    });
    await cleanupTaskTabs(baseTask, "completed", deps);
    expect(spies.closeOwnedTabs).not.toHaveBeenCalled();
  });

  it("closes tabs and broadcasts undo for the parent when policy says close", async () => {
    const undo = { action: "reopen" as const, id: "u", tabs: [] };
    const closeOwnedTabsOverride = vi.fn(async () => undo);
    const { deps, spies } = makeDeps({
      closeOwnedTabs: closeOwnedTabsOverride,
    });
    await cleanupTaskTabs(baseTask, "completed", deps);
    expect(closeOwnedTabsOverride).toHaveBeenCalledWith("conv-1", [
      "ltid-a",
      "ltid-b",
    ]);
    expect(spies.broadcast).toHaveBeenCalledWith({
      type: "AGENT_TABS_CLOSED",
      conversationId: "conv-1",
      undo,
    });
  });

  it("walks descendant subagent conversations and closes their tabs too (A3 fix)", async () => {
    // Parent has ltid-a/ltid-b. It has a subagent child conv-2 with
    // ltid-c. The subagent has a nested child conv-3 with ltid-d.
    const ownedByConv = new Map<string, string[]>([
      ["conv-1", ["ltid-a", "ltid-b"]],
      ["conv-2", ["ltid-c"]],
      ["conv-3", ["ltid-d"]],
    ]);
    const childrenByConv = new Map<string, string[]>([
      ["conv-1", ["conv-2"]],
      ["conv-2", ["conv-3"]],
      ["conv-3", []],
    ]);
    const closeOwnedTabsOverride = vi.fn(
      async (cid: string, _ltids: string[]) => ({
        action: "reopen" as const,
        id: `u-${cid}`,
        tabs: [],
      }),
    );
    const { deps, spies } = makeDeps({
      getConversationOwnedLtids: vi.fn(async (cid: string) =>
        ownedByConv.get(cid) ?? [],
      ),
      listDescendantConversationIds: vi.fn(async (cid: string) =>
        childrenByConv.get(cid) ?? [],
      ),
      closeOwnedTabs: closeOwnedTabsOverride,
    });

    await cleanupTaskTabs(baseTask, "completed", deps);

    // closeOwnedTabs called for every row in the tree.
    expect(closeOwnedTabsOverride).toHaveBeenCalledTimes(3);
    const closedRows = closeOwnedTabsOverride.mock.calls.map((c) => c[0]).sort();
    expect(closedRows).toEqual(["conv-1", "conv-2", "conv-3"]);

    // One broadcast per row (keyed by row's conversationId so the
    // Undo handler can re-open into the correct row).
    expect(spies.broadcast).toHaveBeenCalledTimes(3);
    const broadcastIds = spies.broadcast.mock.calls
      .map((c) => (c[0] as { conversationId: string }).conversationId)
      .sort();
    expect(broadcastIds).toEqual(["conv-1", "conv-2", "conv-3"]);
  });

  it("dedupes a cyclic parent→child→parent graph (defensive)", async () => {
    // conv-1 → conv-2 → conv-1 (cycle). Should visit each row once.
    const ownedByConv = new Map<string, string[]>([
      ["conv-1", ["ltid-a"]],
      ["conv-2", ["ltid-b"]],
    ]);
    const { deps, spies } = makeDeps({
      getConversationOwnedLtids: vi.fn(async (cid: string) =>
        ownedByConv.get(cid) ?? [],
      ),
      listDescendantConversationIds: vi.fn(async (cid: string) =>
        cid === "conv-1" ? ["conv-2"] : cid === "conv-2" ? ["conv-1"] : [],
      ),
    });
    await cleanupTaskTabs(baseTask, "completed", deps);
    expect(spies.closeOwnedTabs).toHaveBeenCalledTimes(2);
  });

  it("a single subagent row failure does not block sibling rows", async () => {
    const ownedByConv = new Map<string, string[]>([
      ["conv-1", ["ltid-a"]],
      ["conv-2", ["ltid-b"]],
      ["conv-3", ["ltid-c"]],
    ]);
    const closeOwnedTabsOverride = vi.fn(
      async (cid: string, _ltids: string[]) => {
        if (cid === "conv-2") throw new Error("chat-db down");
        return { action: "reopen" as const, id: `u-${cid}`, tabs: [] };
      },
    );
    const { deps, spies } = makeDeps({
      getConversationOwnedLtids: vi.fn(async (cid: string) =>
        ownedByConv.get(cid) ?? [],
      ),
      listDescendantConversationIds: vi.fn(async (cid: string) =>
        cid === "conv-1" ? ["conv-2", "conv-3"] : [],
      ),
      closeOwnedTabs: closeOwnedTabsOverride,
    });

    await cleanupTaskTabs(baseTask, "completed", deps);

    // conv-2 fails but conv-1 + conv-3 still cleaned.
    const closedRows = closeOwnedTabsOverride.mock.calls.map((c) => c[0]).sort();
    expect(closedRows).toEqual(["conv-1", "conv-2", "conv-3"]);
    const broadcastIds = spies.broadcast.mock.calls
      .map((c) => (c[0] as { conversationId: string }).conversationId)
      .sort();
    expect(broadcastIds).toEqual(["conv-1", "conv-3"]);
  });

  it("skips broadcast when no tabs were actually closed (empty ltids)", async () => {
    const { deps, spies } = makeDeps({
      getConversationOwnedLtids: vi.fn(async () => []),
    });
    await cleanupTaskTabs(baseTask, "completed", deps);
    expect(spies.closeOwnedTabs).not.toHaveBeenCalled();
    expect(spies.broadcast).not.toHaveBeenCalled();
  });

  it("removes the createdWindowId when policy says close", async () => {
    const { deps, spies } = makeDeps();
    await cleanupTaskTabs(
      { ...baseTask, createdWindowId: 99 },
      "completed",
      deps,
    );
    expect(spies.removeWindow).toHaveBeenCalledWith(99);
  });

  it("does NOT remove a window when there is no createdWindowId", async () => {
    const { deps, spies } = makeDeps();
    await cleanupTaskTabs(baseTask, "completed", deps);
    expect(spies.removeWindow).not.toHaveBeenCalled();
  });

  it("removes window even when there are no owned tabs (window we materialised but never used)", async () => {
    const { deps, spies } = makeDeps({
      getConversationOwnedLtids: vi.fn(async () => []),
    });
    await cleanupTaskTabs(
      { ...baseTask, createdWindowId: 7 },
      "completed",
      deps,
    );
    expect(spies.removeWindow).toHaveBeenCalledWith(7);
  });

  it("null conversationId path: skips tab walk entirely; only removes the window (A4 fix)", async () => {
    const { deps, spies } = makeDeps();
    await cleanupTaskTabs(
      { taskId: "t-null", conversationId: null, createdWindowId: 7 },
      "errored",
      deps,
    );
    expect(spies.closeOwnedTabs).not.toHaveBeenCalled();
    expect(spies.broadcast).not.toHaveBeenCalled();
    expect(spies.removeWindow).toHaveBeenCalledWith(7);
  });

  it("empty-string conversationId is treated same as null (defensive)", async () => {
    const { deps, spies } = makeDeps();
    await cleanupTaskTabs(
      { taskId: "t-empty", conversationId: "", createdWindowId: 3 },
      "completed",
      deps,
    );
    expect(spies.closeOwnedTabs).not.toHaveBeenCalled();
    expect(spies.removeWindow).toHaveBeenCalledWith(3);
  });

  it("swallows errors from closeOwnedTabs so cleanup never throws", async () => {
    const { deps } = makeDeps({
      closeOwnedTabs: vi.fn(async () => {
        throw new Error("chat-db down");
      }),
    });
    await expect(
      cleanupTaskTabs(baseTask, "completed", deps),
    ).resolves.toBeUndefined();
  });

  it("swallows errors from removeWindow so cleanup never throws", async () => {
    const { deps } = makeDeps({
      removeWindow: vi.fn(async () => {
        throw new Error("window already closed");
      }),
    });
    await expect(
      cleanupTaskTabs(
        { ...baseTask, createdWindowId: 5 },
        "completed",
        deps,
      ),
    ).resolves.toBeUndefined();
  });

  it("swallows errors from broadcast (no panel listening)", async () => {
    const { deps, spies } = makeDeps({
      broadcast: vi.fn(async () => {
        throw new Error("no listener");
      }),
    });
    await expect(
      cleanupTaskTabs(baseTask, "completed", deps),
    ).resolves.toBeUndefined();
    expect(spies.closeOwnedTabs).toHaveBeenCalledOnce();
  });

  it("swallows errors from listDescendantConversationIds and still cleans parent", async () => {
    const { deps, spies } = makeDeps({
      listDescendantConversationIds: vi.fn(async () => {
        throw new Error("by-parent index borked");
      }),
    });
    await cleanupTaskTabs(baseTask, "completed", deps);
    expect(spies.closeOwnedTabs).toHaveBeenCalledOnce();
    expect(spies.closeOwnedTabs).toHaveBeenCalledWith("conv-1", [
      "ltid-a",
      "ltid-b",
    ]);
  });

  it("on 'always-close' + cancelled: closes tabs", async () => {
    const { deps, spies } = makeDeps();
    await cleanupTaskTabs(baseTask, "cancelled", deps);
    expect(spies.closeOwnedTabs).toHaveBeenCalled();
  });

  it("on 'always-close' + errored: closes tabs", async () => {
    const { deps, spies } = makeDeps();
    await cleanupTaskTabs(baseTask, "errored", deps);
    expect(spies.closeOwnedTabs).toHaveBeenCalled();
  });
});

describe("cleanup-runtime — collectRowsToClean", () => {
  it("returns just the root when there are no descendants", async () => {
    const deps = {
      listDescendantConversationIds: vi.fn(async () => [] as string[]),
    };
    expect(await collectRowsToClean("root", deps)).toEqual(["root"]);
  });

  it("walks transitively (BFS order, root first)", async () => {
    const children: Record<string, string[]> = {
      root: ["a", "b"],
      a: ["a1"],
      b: [],
      a1: [],
    };
    const deps = {
      listDescendantConversationIds: vi.fn(async (cid: string) =>
        children[cid] ?? [],
      ),
    };
    const result = await collectRowsToClean("root", deps);
    // BFS so root then immediate children then grandchildren.
    expect(result).toEqual(["root", "a", "b", "a1"]);
  });

  it("dedupes diamond/cyclic graphs", async () => {
    const children: Record<string, string[]> = {
      root: ["a", "b"],
      a: ["c"],
      b: ["c"], // c reachable from both a and b
      c: ["root"], // cycle back to root
    };
    const deps = {
      listDescendantConversationIds: vi.fn(async (cid: string) =>
        children[cid] ?? [],
      ),
    };
    const result = await collectRowsToClean("root", deps);
    expect(result.sort()).toEqual(["a", "b", "c", "root"]);
  });

  it("hard-caps depth (defense against unbounded recursion)", async () => {
    // Build a linear chain 100 deep. Should bottom out at the depth cap.
    const deps = {
      listDescendantConversationIds: vi.fn(async (cid: string) => {
        const n = parseInt(cid.replace("c", ""), 10);
        return Number.isFinite(n) ? [`c${n + 1}`] : [];
      }),
    };
    const result = await collectRowsToClean("c0", deps);
    // MAX_DESCENDANT_DEPTH = 8 → root + 8 levels = at most 9 entries.
    expect(result.length).toBeLessThanOrEqual(9);
    expect(result[0]).toBe("c0");
  });

  it("survives one bad listDescendant call without throwing", async () => {
    const deps = {
      listDescendantConversationIds: vi.fn(async (cid: string) => {
        if (cid === "a") throw new Error("borked");
        return cid === "root" ? ["a", "b"] : [];
      }),
    };
    const result = await collectRowsToClean("root", deps);
    // a's children aren't visible, but the walk continues with b.
    expect(result.sort()).toEqual(["a", "b", "root"]);
  });
});

describe("cleanup-runtime — sweepOrphanedMcpTasks (A6)", () => {
  // The sweep dynamically imports @/lib/chat-db. We have to stub the
  // module before each test using vi.mock semantics; simplest is to
  // stub `chrome` minimal + use a manual mock factory.

  const fakeConversations: { id: string; source?: string }[] = [];

  beforeEach(() => {
    fakeConversations.length = 0;
    vi.doMock("@/lib/chat-db", () => ({
      chatDb: {
        listMcpConversations: vi.fn(async () => fakeConversations),
        getConversation: vi.fn(async () => undefined),
        listChildren: vi.fn(async () => []),
      },
    }));
  });

  afterEach(() => {
    vi.doUnmock("@/lib/chat-db");
    vi.resetModules();
  });

  it("returns empty arrays when chat-db has no MCP conversations", async () => {
    const { sweepOrphanedMcpTasks } = await import("../cleanup-runtime");
    const { deps } = makeDeps();
    const result = await sweepOrphanedMcpTasks({
      isLive: () => false,
      deps,
    });
    expect(result).toEqual({ swept: [], skipped: [] });
  });

  it("skips live runs (those with a non-terminal tasksStore entry)", async () => {
    fakeConversations.push({ id: "conv-live", source: "mcp" });
    fakeConversations.push({ id: "conv-orphan", source: "mcp" });

    const { sweepOrphanedMcpTasks } = await import("../cleanup-runtime");
    const closeOwnedTabsSpy = vi.fn(async () => ({
      action: "reopen" as const,
      id: "u",
      tabs: [],
    }));
    const { deps } = makeDeps({
      // Pretend both conversations have one owned tab to make the
      // close path observable.
      getConversationOwnedLtids: vi.fn(async () => ["ltid"]),
      closeOwnedTabs: closeOwnedTabsSpy,
    });
    const result = await sweepOrphanedMcpTasks({
      isLive: (cid) => cid === "conv-live",
      deps,
    });
    expect(result.skipped).toEqual(["conv-live"]);
    expect(result.swept).toEqual(["conv-orphan"]);
    // Only the orphan's tabs got closed.
    expect(closeOwnedTabsSpy).toHaveBeenCalledOnce();
    expect(closeOwnedTabsSpy).toHaveBeenCalledWith("conv-orphan", ["ltid"]);
  });

  it("treats orphans as completed for policy purposes", async () => {
    fakeConversations.push({ id: "conv-1", source: "mcp" });
    const { sweepOrphanedMcpTasks } = await import("../cleanup-runtime");
    // Policy = close-on-cancel-only: completed orphans NOT closed.
    const getSettingsSpy = vi.fn(async () => ({
      mcpAfterTaskTabPolicy: "close-on-cancel-only" as TabCleanupPolicy,
    }));
    const closeOwnedTabsSpy = vi.fn(async () => ({
      action: "reopen" as const,
      id: "u",
      tabs: [],
    }));
    const { deps } = makeDeps({
      getSettings: getSettingsSpy,
      getConversationOwnedLtids: vi.fn(async () => ["ltid"]),
      closeOwnedTabs: closeOwnedTabsSpy,
    });
    await sweepOrphanedMcpTasks({
      isLive: () => false,
      deps,
    });
    expect(closeOwnedTabsSpy).not.toHaveBeenCalled();
  });

  it("does not throw when one row's cleanup fails", async () => {
    fakeConversations.push({ id: "conv-1", source: "mcp" });
    fakeConversations.push({ id: "conv-2", source: "mcp" });
    const { sweepOrphanedMcpTasks } = await import("../cleanup-runtime");
    const closeOwnedTabsSpy = vi.fn(async (cid: string) => {
      if (cid === "conv-1") throw new Error("nope");
      return { action: "reopen" as const, id: "u", tabs: [] };
    });
    const { deps } = makeDeps({
      getConversationOwnedLtids: vi.fn(async () => ["ltid"]),
      closeOwnedTabs: closeOwnedTabsSpy,
    });
    const result = await sweepOrphanedMcpTasks({
      isLive: () => false,
      deps,
    });
    // Both still recorded as swept (best-effort); the inner error
    // does not bubble.
    expect(result.swept.sort()).toEqual(["conv-1", "conv-2"]);
  });
});

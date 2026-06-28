import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Per-tab overlay state for parallel-tab agent runs.
 *
 * Pre-refactor design: `agent-indicator.ts` held two module-scope
 * globals — `currentSpaceColor` and `lastIndicatorTabId`. With one
 * conversation streaming at a time, that was fine. Under SW-host:
 *
 *   - N parallel top-level conversations can run concurrently, each
 *     in its own Space (different colors).
 *   - A single conversation can spawn N parallel subagents (via
 *     `delegate`), each driving its own working tab via the CUA loop.
 *     The user perceives this as ONE chat working multiple tabs.
 *
 * Either case clobbers the singletons:
 *
 *   - `currentSpaceColor`: last writer wins. A subagent on a different
 *     space, or another conversation, paints its color over the
 *     parent's.
 *   - `lastIndicatorTabId`: each call to `notifyAgentStatus` flips the
 *     "single working tab" pointer. When a peer subagent's tool fires
 *     against a different tab, the prior tab's overlay is cleared even
 *     though the prior subagent is still working.
 *
 * The refactor replaces both with a per-tabId map keyed by `tabId`,
 * with `conversationId` ownership stamped so `resetAgentIndicator(cid)`
 * only clears tabs owned by that cid (parent and child overlays are
 * peers — clearing the parent must not clear the child's working tab).
 *
 * Color becomes a required call-site argument: the caller knows the
 * conversation context (parent: agentConversationId; subagent CUA:
 * `cfg.spaceColor`) and looks up the color synchronously. No more
 * cross-realm `AGENT_SPACE_COLOR_SET` bridge.
 */

function makeFakeChrome() {
  const sendMessageCalls: Array<{ tabId: number; message: Record<string, unknown> }> = [];
  const runtimeSendCalls: Array<Record<string, unknown>> = [];
  return {
    sendMessageCalls,
    runtimeSendCalls,
    chrome: {
      tabs: {
        get: vi.fn((tabId: number) =>
          Promise.resolve({ id: tabId, url: `https://example.com/${tabId}` } as chrome.tabs.Tab),
        ),
        sendMessage: vi.fn((tabId: number, message: Record<string, unknown>) => {
          sendMessageCalls.push({ tabId, message });
          return Promise.resolve({ ok: true });
        }),
      },
      runtime: {
        sendMessage: vi.fn((msg: Record<string, unknown>) => {
          runtimeSendCalls.push(msg);
          return Promise.resolve();
        }),
        getURL: vi.fn((p: string) => `chrome-extension://test/${p}`),
      },
      scripting: { executeScript: vi.fn(() => Promise.resolve()) },
    } as unknown as typeof chrome,
  };
}

describe("agent-indicator: per-tab parallel runs", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doMock("../cdp-capture", () => ({
      startCapture: vi.fn(() => Promise.resolve()),
    }));
    vi.doMock("../active-tab", () => ({
      sendToContentScript: vi.fn(
        async (tabId: number, message: Record<string, unknown>) => {
          // Track via the chrome stub for cross-cutting assertions.
          await (globalThis as unknown as { chrome: typeof chrome }).chrome.tabs.sendMessage(
            tabId,
            message,
          );
          return { ok: true };
        },
      ),
      getTargetTabId: vi.fn(() => null),
    }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("two conversations working two tabs concurrently: each tab gets its own color", async () => {
    const { chrome: fake, sendMessageCalls } = makeFakeChrome();
    vi.stubGlobal("chrome", fake);

    const { notifyAgentStatus } = await import("../agent-indicator");

    // Convo A on tab 100, blue. Convo B on tab 200, orange. Both
    // working simultaneously.
    await notifyAgentStatus(true, {
      tabId: 100,
      color: "#3b82f6",
      conversationId: "conv-A",
    });
    await notifyAgentStatus(true, {
      tabId: 200,
      color: "#f97316",
      conversationId: "conv-B",
    });

    // Both tabs must have received their working overlay with the
    // right color. Neither tab must have received an "active:false"
    // (which is the pre-refactor lastIndicatorTabId-clobber bug).
    const tab100Working = sendMessageCalls.filter(
      (c) => c.tabId === 100 && c.message.active === true,
    );
    const tab200Working = sendMessageCalls.filter(
      (c) => c.tabId === 200 && c.message.active === true,
    );
    const tab100Cleared = sendMessageCalls.filter(
      (c) => c.tabId === 100 && c.message.active === false,
    );

    expect(tab100Working).toHaveLength(1);
    expect(tab100Working[0].message.color).toBe("#3b82f6");
    expect(tab200Working).toHaveLength(1);
    expect(tab200Working[0].message.color).toBe("#f97316");
    // Pre-refactor: notifyAgentStatus(true, …, 200) would clear tab 100
    // because lastIndicatorTabId === 100 !== 200. With per-tab state,
    // that clobber is gone.
    expect(tab100Cleared).toHaveLength(0);
  });

  it("one conversation + one subagent, both working different tabs: peers coexist", async () => {
    const { chrome: fake, sendMessageCalls } = makeFakeChrome();
    vi.stubGlobal("chrome", fake);

    const { notifyAgentStatus } = await import("../agent-indicator");

    // Parent works tab 100. Subagent A works tab 200. Subagent B
    // works tab 300. All three should glow with the SAME space color
    // (they inherit from the parent's space) but on different tabs.
    await notifyAgentStatus(true, {
      tabId: 100,
      color: "#3b82f6",
      conversationId: "parent",
    });
    await notifyAgentStatus(true, {
      tabId: 200,
      color: "#3b82f6",
      conversationId: "child-A",
    });
    await notifyAgentStatus(true, {
      tabId: 300,
      color: "#3b82f6",
      conversationId: "child-B",
    });

    expect(
      sendMessageCalls.filter((c) => c.message.active === true).map((c) => c.tabId).sort(),
    ).toEqual([100, 200, 300]);

    // No tab should have been cleared as a side effect of another
    // tab going active.
    expect(sendMessageCalls.filter((c) => c.message.active === false)).toHaveLength(0);
  });

  it("resetAgentIndicator(cid) only clears tabs owned by that cid", async () => {
    const { chrome: fake, sendMessageCalls } = makeFakeChrome();
    vi.stubGlobal("chrome", fake);

    const { notifyAgentStatus, resetAgentIndicator } = await import(
      "../agent-indicator"
    );

    await notifyAgentStatus(true, {
      tabId: 100,
      color: "#3b82f6",
      conversationId: "parent",
    });
    await notifyAgentStatus(true, {
      tabId: 200,
      color: "#3b82f6",
      conversationId: "child-A",
    });

    // Subagent A finishes; parent is still working.
    await resetAgentIndicator("child-A");

    // tab 200 should now have an active:false message. tab 100 should
    // NOT have received a clear.
    const tab200Cleared = sendMessageCalls.filter(
      (c) => c.tabId === 200 && c.message.active === false,
    );
    const tab100Cleared = sendMessageCalls.filter(
      (c) => c.tabId === 100 && c.message.active === false,
    );

    expect(tab200Cleared).toHaveLength(1);
    expect(tab100Cleared).toHaveLength(0);
  });

  it("one conversation moving between tabs: prior tab cleared when same cid claims a new tab", async () => {
    const { chrome: fake, sendMessageCalls } = makeFakeChrome();
    vi.stubGlobal("chrome", fake);

    const { notifyAgentStatus } = await import("../agent-indicator");

    // Convo A starts on tab 100, then its next tool moves to tab 200.
    // The overlay should follow: tab 100 cleared, tab 200 working.
    await notifyAgentStatus(true, {
      tabId: 100,
      color: "#3b82f6",
      conversationId: "conv-A",
    });
    await notifyAgentStatus(true, {
      tabId: 200,
      color: "#3b82f6",
      conversationId: "conv-A",
    });

    // tab 100 cleared (because conv-A moved off it).
    const tab100Cleared = sendMessageCalls.filter(
      (c) => c.tabId === 100 && c.message.active === false,
    );
    expect(tab100Cleared).toHaveLength(1);
    // tab 200 working with the right color.
    const tab200Working = sendMessageCalls.filter(
      (c) => c.tabId === 200 && c.message.active === true,
    );
    expect(tab200Working).toHaveLength(1);
    expect(tab200Working[0].message.color).toBe("#3b82f6");
  });

  it("idle notification clears only the specified tab", async () => {
    const { chrome: fake, sendMessageCalls } = makeFakeChrome();
    vi.stubGlobal("chrome", fake);

    const { notifyAgentStatus } = await import("../agent-indicator");

    await notifyAgentStatus(true, {
      tabId: 100,
      color: "#3b82f6",
      conversationId: "conv-A",
    });
    await notifyAgentStatus(true, {
      tabId: 200,
      color: "#3b82f6",
      conversationId: "conv-B",
    });

    // conv-A goes idle on its own tab — but the explicit tabId path
    // does NOT require a cid match; idle on tab 100 clears tab 100,
    // period.
    await notifyAgentStatus(false, {
      tabId: 100,
      conversationId: "conv-A",
    });

    const tab100Cleared = sendMessageCalls.filter(
      (c) => c.tabId === 100 && c.message.active === false,
    );
    const tab200Cleared = sendMessageCalls.filter(
      (c) => c.tabId === 200 && c.message.active === false,
    );
    expect(tab100Cleared).toHaveLength(1);
    expect(tab200Cleared).toHaveLength(0);
  });

  it("internal pages (chrome://, chrome-extension://, devtools://) are skipped without state mutation", async () => {
    const { chrome: fake, sendMessageCalls } = makeFakeChrome();
    fake.tabs.get = vi.fn((tabId: number) =>
      Promise.resolve({
        id: tabId,
        url: tabId === 999 ? "chrome://settings/" : `https://example.com/${tabId}`,
      } as chrome.tabs.Tab),
    );
    vi.stubGlobal("chrome", fake);

    const { notifyAgentStatus } = await import("../agent-indicator");

    await notifyAgentStatus(true, {
      tabId: 999, // internal page
      color: "#3b82f6",
      conversationId: "conv-A",
    });

    // No content-script message should be sent to the chrome:// tab.
    expect(sendMessageCalls.filter((c) => c.tabId === 999)).toHaveLength(0);
  });

  it("internal-page IDLE call clears state + posts AGENT_TAB_IDLE (#16)", async () => {
    // Regression: when a tab navigates to chrome:// (or any internal
    // page) while a run is mid-flight, then the run ends and calls
    // `notifyAgentStatus(false, …)` on it, the early-return previously
    // skipped both the `sendToContentScript` (correct — no content
    // script there) AND the local map cleanup (wrong — leaks the
    // indicator state). The AGENT_TAB_IDLE mirror also went stale.
    //
    // Fix: split the early-return so idle/reset paths still drop
    // `indicatorStateByTab` + `tabsByConversation` + post AGENT_TAB_IDLE,
    // even when the URL is internal.
    const { chrome: fake, runtimeSendCalls, sendMessageCalls } =
      makeFakeChrome();
    // First call: tab is a normal page (working).
    let url = "https://example.com/3";
    fake.tabs.get = vi.fn((tabId: number) =>
      Promise.resolve({ id: tabId, url } as chrome.tabs.Tab),
    );
    vi.stubGlobal("chrome", fake);

    const { notifyAgentStatus, resetAgentIndicator } = await import(
      "../agent-indicator"
    );

    // Pre-populate state on tab 3.
    await notifyAgentStatus(true, {
      tabId: 3,
      color: "#aabbcc",
      conversationId: "conv-Z",
    });

    // Now the tab navigates to chrome://.
    url = "chrome://settings/";
    sendMessageCalls.length = 0;
    runtimeSendCalls.length = 0;

    await notifyAgentStatus(false, { tabId: 3, conversationId: "conv-Z" });

    // AGENT_TAB_IDLE must have been broadcast so the SW mirror is in
    // sync.
    expect(
      runtimeSendCalls.some(
        (m) => m.type === "AGENT_TAB_IDLE" && m.tabId === 3,
      ),
    ).toBe(true);

    // The state must have been dropped — verified by a subsequent
    // `resetAgentIndicator("conv-Z")` doing no further work (its
    // tab set is now empty).
    sendMessageCalls.length = 0;
    runtimeSendCalls.length = 0;
    await resetAgentIndicator("conv-Z");
    expect(sendMessageCalls.filter((c) => c.tabId === 3)).toHaveLength(0);
    expect(
      runtimeSendCalls.some(
        (m) => m.type === "AGENT_TAB_IDLE" && m.tabId === 3,
      ),
    ).toBe(false);
  });

  it("omitting conversationId preserves the prior tab owner (#17)", async () => {
    // Regression: `notifyAgentStatus(true, { tabId, color })` (no
    // `conversationId` key in opts) used to normalize to `null` and
    // strip the prior owner's ownership in `tabsByConversation`. That
    // broke `resetAgentIndicator(cid)` after such a "context-less"
    // refresh. Distinguish:
    //   - undefined (key absent) → preserve prior owner
    //   - null (key present, explicit) → no owner
    //   - string → claim ownership
    const { chrome: fake, sendMessageCalls } = makeFakeChrome();
    vi.stubGlobal("chrome", fake);

    const { notifyAgentStatus, resetAgentIndicator } = await import(
      "../agent-indicator"
    );

    // conv-X claims tab 50.
    await notifyAgentStatus(true, {
      tabId: 50,
      color: "#112233",
      conversationId: "conv-X",
    });

    // A subsequent refresh with no conversationId in opts — e.g. an
    // internal helper that only knows the tab.
    await notifyAgentStatus(true, { tabId: 50, color: "#112233" });

    // resetAgentIndicator("conv-X") must still find the tab.
    sendMessageCalls.length = 0;
    await resetAgentIndicator("conv-X");
    // Active=false must have been sent to tab 50.
    expect(
      sendMessageCalls.some(
        (c) =>
          c.tabId === 50 &&
          c.message.type === "CHAT_CUA_WORKING_STATE" &&
          c.message.active === false,
      ),
    ).toBe(true);
  });

  it("sequential ownership transitions converge to the final claim's overlay state", async () => {
    // Scenario covered:
    //   - conv-A claims tab 1.
    //   - conv-A claims tab 2: this enqueues a `CHAT_CUA_WORKING_STATE(false)`
    //     teardown onto tab 1's serial queue (conv-A's prior-tab cleanup).
    //   - conv-B claims tab 1 while tab 1's queue is still blocked on
    //     that pending teardown's `chrome.tabs.get(1)`. conv-B's claim
    //     enqueues onto tab 1's queue behind the teardown.
    //   - The teardown's `tab.get(1)` resolves, the teardown runs, then
    //     conv-B's claim runs.
    //
    // The assertion: after all queued work settles, the LAST
    // `CHAT_CUA_WORKING_STATE` message posted to tab 1 is `active: true`
    // (conv-B's overlay), not a leftover `active: false` from conv-A's
    // teardown. This is the convergent-final-state contract the user
    // perceives — the overlay reflects whoever last claimed the tab.
    //
    // Note on the ownership-re-check guard at
    // `agent-indicator.ts:213-218`: that guard is defense-in-depth. All
    // production mutations to `indicatorStateByTab` flow through
    // `enqueueForTab`'s serial queue, so the queued teardown's
    // re-check always sees the same ownership snapshot it was enqueued
    // against — a peer cid cannot mutate state ahead of the teardown
    // because its own mutation is itself queued behind. Exercising the
    // guard's bail branch would require exposing
    // `indicatorStateByTab.set` to test-only callers (or a future
    // code path that bypasses the queue). This test verifies the
    // observable contract; the guard remains as a safety net for
    // hypothetical future paths that skip the queue.
    const { chrome: fake, sendMessageCalls } = makeFakeChrome();
    vi.stubGlobal("chrome", fake);

    const { notifyAgentStatus } = await import("../agent-indicator");

    // Block tab.get on tab 1 with a controllable promise so we can
    // sequence the prior-tab clear in the middle of conv-A's tab-2
    // claim AND inject conv-B's claim of tab 1 between them.
    type Resolver = (tab: chrome.tabs.Tab) => void;
    const resolverHolder: { fn: Resolver | null } = { fn: null };
    let getTab1Pending = false;
    fake.tabs.get = vi.fn((tabId: number) => {
      if (tabId === 1 && getTab1Pending) {
        return new Promise<chrome.tabs.Tab>((res) => {
          resolverHolder.fn = (t) => res(t);
        });
      }
      return Promise.resolve({
        id: tabId,
        url: `https://example.com/${tabId}`,
      } as chrome.tabs.Tab);
    });

    // 1. conv-A claims tab 1 with default tab.get (returns immediately).
    await notifyAgentStatus(true, {
      tabId: 1,
      color: "#aaaaaa",
      conversationId: "conv-A",
    });

    // 2. conv-A claims tab 2 — this enqueues a teardown onto tab 1's
    //    queue. The queued teardown's tab.get(1) will block.
    getTab1Pending = true;
    const tab2Claim = notifyAgentStatus(true, {
      tabId: 2,
      color: "#aaaaaa",
      conversationId: "conv-A",
    });

    // Give tab2Claim a chance to enqueue the teardown.
    await Promise.resolve();
    await Promise.resolve();

    // 3. conv-B claims tab 1 — its claim sits in tab 1's serial queue
    //    behind the still-blocked teardown.
    const convBClaim = notifyAgentStatus(true, {
      tabId: 1,
      color: "#bbbbbb",
      conversationId: "conv-B",
    });

    // 4. Release the teardown's blocked tab.get. The teardown runs,
    //    then conv-B's claim runs.
    if (resolverHolder.fn) {
      resolverHolder.fn({
        id: 1,
        url: "https://example.com/1",
      } as chrome.tabs.Tab);
    }
    getTab1Pending = false;
    await tab2Claim;
    await convBClaim;

    // Final state assertion: the most recent message to tab 1 must be
    // conv-B's active=true overlay, regardless of any intermediate
    // teardown frame.
    const tab1Msgs = sendMessageCalls.filter((c) => c.tabId === 1);
    const lastActive = tab1Msgs[tab1Msgs.length - 1];
    expect(lastActive?.message).toMatchObject({
      type: "CHAT_CUA_WORKING_STATE",
      active: true,
    });
  });
});

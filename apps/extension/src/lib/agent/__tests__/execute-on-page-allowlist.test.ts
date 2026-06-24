import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Repro for: "I clicked 'Always allow on bookface.ycombinator.com' but
 * subsequent executeOnPage calls still required approval / got declined."
 *
 * The user confirmed the page stayed on bookface the whole time (constant
 * origin) and the grant was on an EARLIER call. So this exercises the real
 * integration the unit test (tool-approval-block.test.ts) does NOT cover:
 *
 *   allowToolOnSite("executeOnPage", origin)   // what "Always allow" persists
 *   -> needsApproval({ input: { tab } })       // what the NEXT call evaluates
 *
 * Expectation: after the grant, a same-origin executeOnPage call must NOT
 * require approval (needsApproval === false).
 */

const ORIGIN = "https://bookface.ycombinator.com";
const TAB_ID = 42;
const CID = "conv-allowlist-repro";

function installChromeStub() {
  const store: Record<string, unknown> = {};
  vi.stubGlobal("chrome", {
    runtime: {
      id: "test-extension",
      onMessage: { addListener: () => {}, removeListener: () => {} },
      sendMessage: () => Promise.resolve({ ok: true }),
      onStartup: { addListener: () => {} },
      onInstalled: { addListener: () => {} },
      getURL: (p: string) => `chrome-extension://test/${p}`,
      lastError: undefined,
    },
    tabs: {
      onRemoved: { addListener: () => {}, removeListener: () => {} },
      onUpdated: { addListener: () => {}, removeListener: () => {} },
      onActivated: { addListener: () => {}, removeListener: () => {} },
      // Same tab, same URL throughout — mirrors "stayed on bookface".
      get: (id: number) =>
        Promise.resolve({
          id,
          url: `${ORIGIN}/home`,
          title: "Bookface",
          favIconUrl: undefined,
        }),
      query: () => Promise.resolve([]),
      sendMessage: () => Promise.resolve(undefined),
    },
    storage: {
      local: {
        get: (key?: string | string[]) => {
          if (typeof key === "string") return Promise.resolve({ [key]: store[key] });
          return Promise.resolve({ ...store });
        },
        set: (obj: Record<string, unknown>) => {
          Object.assign(store, obj);
          return Promise.resolve();
        },
        remove: () => Promise.resolve(),
      },
      onChanged: { addListener: () => {}, removeListener: () => {} },
    },
    windows: { getCurrent: () => Promise.resolve({ id: 1 }) },
    debugger: {
      onDetach: { addListener: () => {}, removeListener: () => {} },
      onEvent: { addListener: () => {}, removeListener: () => {} },
      attach: () => Promise.resolve(),
      detach: () => Promise.resolve(),
      sendCommand: () => Promise.resolve({}),
    },
    scripting: {
      executeScript: () => Promise.resolve([]),
      insertCSS: () => Promise.resolve(),
    },
  });
}

describe("executeOnPage allowlist integration (Always allow repro)", () => {
  beforeEach(() => {
    installChromeStub();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("does not require approval after Always-allow grants the same origin", async () => {
    const { toSDKTool, allowToolOnSite, setAgentContext, getToolSiteAllowlist } =
      await import("@/lib/agent/agent-transport");
    const { executeOnPageTool } = await import("@/lib/agent/tools");
    const { getOrCreateHandle } = await import("@/lib/agent/tab-handles");
    const { tabRegistry } = await import("@/lib/agent/tab-registry");

    // Bind the active conversation + a live tab handle, like a real run.
    setAgentContext(CID);
    // Mint an ltid for the test ctid via the registry; getOrCreateHandle
    // takes ltids post-migration.
    const ltid = tabRegistry.registerExisting(TAB_ID);
    const handle = getOrCreateHandle(CID, ltid);

    // Simulate clicking "Always allow on bookface.ycombinator.com" on an
    // earlier call: persist the grant for the executeOnPage tool + origin.
    await allowToolOnSite("executeOnPage", ORIGIN);

    // Sanity: the grant landed in storage with the exact origin.
    const allowlist = await getToolSiteAllowlist();
    expect(allowlist.executeOnPage).toContain(ORIGIN);

    // Now the NEXT executeOnPage call on the SAME origin should skip approval.
    const tool = toSDKTool(executeOnPageTool, "executeOnPage");

    // CRITICAL: the AI SDK invokes needsApproval as
    //   needsApproval(input, { toolCallId, messages, experimental_context })
    // i.e. `input` is the FIRST POSITIONAL ARG (the tool's parsed input),
    // not `{ input }`. Call it exactly the way the SDK does — otherwise the
    // test silently conforms to the very bug it's meant to catch (a previous
    // version destructured `{ input }`, read `input.input` === undefined, and
    // always required approval).
    const needsApproval = tool.needsApproval as (
      input: unknown,
      options: { toolCallId: string; messages: unknown[] },
    ) => Promise<boolean> | boolean;
    expect(typeof needsApproval).toBe("function");

    const requiresApproval = await needsApproval(
      { tab: handle, code: "return 1" },
      { toolCallId: "call-1", messages: [] },
    );

    expect(requiresApproval).toBe(false);
  });
});

describe("executeOnPage scriptRef approval (trusted saved-script runs)", () => {
  beforeEach(() => {
    installChromeStub();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  async function needsApprovalFor(input: unknown): Promise<boolean | undefined> {
    const { toSDKTool, setAgentContext } = await import(
      "@/lib/agent/agent-transport"
    );
    const { executeOnPageTool } = await import("@/lib/agent/tools");
    const { getOrCreateHandle } = await import("@/lib/agent/tab-handles");
    const { tabRegistry } = await import("@/lib/agent/tab-registry");
    setAgentContext(CID);
    getOrCreateHandle(CID, tabRegistry.registerExisting(TAB_ID));
    const tool = toSDKTool(executeOnPageTool, "executeOnPage");
    const fn = tool.needsApproval as (
      i: unknown,
      o: { toolCallId: string; messages: unknown[] },
    ) => Promise<boolean> | boolean;
    return fn(input, { toolCallId: "c", messages: [] });
  }

  it("skips approval for a scriptRef run (no inline code), even with no allowlist grant", async () => {
    const { getOrCreateHandle } = await import("@/lib/agent/tab-handles");
    const { tabRegistry } = await import("@/lib/agent/tab-registry");
    const handle = getOrCreateHandle(CID, tabRegistry.registerExisting(TAB_ID));
    const out = await needsApprovalFor({
      tab: handle,
      scriptRef: { domain: "bookface.ycombinator.com", name: "extract" },
    });
    expect(out).toBe(false);
  });

  it("still requires approval for inline code on a non-allowlisted origin", async () => {
    const { getOrCreateHandle } = await import("@/lib/agent/tab-handles");
    const { tabRegistry } = await import("@/lib/agent/tab-registry");
    const handle = getOrCreateHandle(CID, tabRegistry.registerExisting(TAB_ID));
    const out = await needsApprovalFor({ tab: handle, code: "return 1" });
    expect(out).toBe(true);
  });

  it("requires approval when BOTH code and scriptRef are present (treats as inline)", async () => {
    const { getOrCreateHandle } = await import("@/lib/agent/tab-handles");
    const { tabRegistry } = await import("@/lib/agent/tab-registry");
    const handle = getOrCreateHandle(CID, tabRegistry.registerExisting(TAB_ID));
    const out = await needsApprovalFor({
      tab: handle,
      code: "return 1",
      scriptRef: { domain: "bookface.ycombinator.com", name: "x" },
    });
    expect(out).toBe(true);
  });
});

describe("executeOnPage verified-read fast path (kind: read on allowlisted origin)", () => {
  beforeEach(() => {
    installChromeStub();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  async function setupHandle(): Promise<string> {
    const { setAgentContext } = await import("@/lib/agent/agent-transport");
    const { getOrCreateHandle } = await import("@/lib/agent/tab-handles");
    const { tabRegistry } = await import("@/lib/agent/tab-registry");
    setAgentContext(CID);
    const ltid = tabRegistry.registerExisting(TAB_ID);
    return getOrCreateHandle(CID, ltid);
  }

  async function needsApprovalFor(input: unknown): Promise<boolean | undefined> {
    const { toSDKTool } = await import("@/lib/agent/agent-transport");
    const { executeOnPageTool } = await import("@/lib/agent/tools");
    const tool = toSDKTool(executeOnPageTool, "executeOnPage");
    const fn = tool.needsApproval as (
      i: unknown,
      o: { toolCallId: string; messages: unknown[] },
    ) => Promise<boolean> | boolean;
    return fn(input, { toolCallId: "x", messages: [] });
  }

  it("skips approval for kind: read on an allowlisted origin (verified by static check)", async () => {
    const handle = await setupHandle();
    const { allowToolOnSite } = await import("@/lib/agent/agent-transport");
    await allowToolOnSite("executeOnPage", ORIGIN);

    const out = await needsApprovalFor({
      tab: handle,
      kind: "read",
      code: "return document.title;",
    });

    expect(out).toBe(false);
  });

  it("skips approval for kind: read on a NON-allowlisted origin (verified read needs no allowlist)", async () => {
    const handle = await setupHandle();
    const out = await needsApprovalFor({
      tab: handle,
      kind: "read",
      code: "return document.title;",
    });
    expect(out).toBe(false);
  });

  it("treats AST-rejected read as a write — skips on allowlisted origin", async () => {
    const handle = await setupHandle();
    const { allowToolOnSite } = await import("@/lib/agent/agent-transport");
    await allowToolOnSite("executeOnPage", ORIGIN);

    const out = await needsApprovalFor({
      tab: handle,
      kind: "read",
      // claims read but writes — fast path rejects, falls through to allowlist
      code: "document.querySelector('a').click(); return 1;",
    });

    // AST-rejected: treated as write. Allowlisted origin → skip.
    expect(out).toBe(false);
  });

  it("treats AST-rejected read as a write — gates on non-allowlisted origin", async () => {
    const handle = await setupHandle();
    const out = await needsApprovalFor({
      tab: handle,
      kind: "read",
      code: "document.querySelector('a').click(); return 1;",
    });

    // AST-rejected: treated as write. No allowlist → gate.
    expect(out).toBe(true);
  });

  it("kind: write skips on allowlisted origin (existing tab-tool allowlist behavior)", async () => {
    const handle = await setupHandle();
    const { allowToolOnSite } = await import("@/lib/agent/agent-transport");
    await allowToolOnSite("executeOnPage", ORIGIN);

    const out = await needsApprovalFor({
      tab: handle,
      kind: "write",
      code: "return document.title;",
    });
    expect(out).toBe(false);
  });

  it("kind: write gates on a NON-allowlisted origin", async () => {
    const handle = await setupHandle();
    const out = await needsApprovalFor({
      tab: handle,
      kind: "write",
      code: "return document.title;",
    });
    expect(out).toBe(true);
  });
});

import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Mode-aware `needsApproval` integration tests.
 *
 * Exercises the wrapper around the per-tool approval chain in
 * `agent-transport.ts`'s `toSDKTool`:
 *
 *   - Ask mode    → fall through to existing per-tool logic.
 *   - Plan mode   → in-plan calls skip; off-plan calls gate.
 *                   `proposePlan` is always gated (it IS the approval).
 *   - Act mode    → skip approvals, EXCEPT for executePython requesting
 *                   network when the conversation's plan disallows it
 *                   (the network floor still binds).
 *
 * The headless `autoApprove` wrapper sits OUTSIDE this dispatch and
 * always wins; that's covered by execute-python-approval.test.ts.
 */

const CID = "conv-plan-mode";
const PLAN_SITE = "https://kilo.ai";
const OFF_SITE = "https://other.com";
const PLAN_TAB_ID = 100;
const OFF_TAB_ID = 200;

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
      // Per-tab-id URL: the in-plan tab resolves to PLAN_SITE, the
      // off-plan tab resolves to OFF_SITE. Tests pick whichever id they
      // need based on what they're asserting.
      get: (id: number) => {
        if (id === PLAN_TAB_ID) {
          return Promise.resolve({
            id,
            url: `${PLAN_SITE}/path`,
            title: "Kilo",
            favIconUrl: undefined,
          });
        }
        if (id === OFF_TAB_ID) {
          return Promise.resolve({
            id,
            url: `${OFF_SITE}/path`,
            title: "Other",
            favIconUrl: undefined,
          });
        }
        return Promise.reject(new Error(`No such tab: ${id}`));
      },
      query: () => Promise.resolve([]),
      sendMessage: () => Promise.resolve(undefined),
    },
    storage: {
      local: {
        get: (key?: string | string[]) => {
          if (typeof key === "string")
            return Promise.resolve({ [key]: store[key] });
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

/**
 * Seed a conversation with the given mode/plan, registering both tab ids
 * with the registry so handles for either origin are mintable.
 *
 * Returns handles for the in-plan and off-plan tabs so each test can
 * pick whichever it needs as input to `executeOnPage`. (executePython
 * doesn't take a tab handle, so its tests ignore these.)
 */
async function seedConversation(opts: {
  mode: "ask" | "plan" | "act";
  plan?: import("@/lib/types").ApprovedPlan;
}): Promise<{ planHandle: string; offHandle: string }> {
  const { chatDb } = await import("@/lib/chat-db");
  const { setAgentContext } = await import("@/lib/agent/agent-transport");
  const { getOrCreateHandle } = await import("@/lib/agent/tab-handles");
  const { tabRegistry } = await import("@/lib/agent/tab-registry");

  await chatDb.createConversation({
    id: CID,
    title: "test",
    spaceId: null,
    ownedGroupId: null,
    ownedLtids: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  await chatDb.updateConversation(CID, {
    mode: opts.mode,
    plan: opts.plan,
    updatedAt: Date.now(),
  });

  setAgentContext(CID);
  const planLtid = tabRegistry.registerExisting(PLAN_TAB_ID);
  const offLtid = tabRegistry.registerExisting(OFF_TAB_ID);
  const planHandle = getOrCreateHandle(CID, planLtid);
  const offHandle = getOrCreateHandle(CID, offLtid);
  return { planHandle, offHandle };
}

async function needsApprovalForTool(
  toolKey: "executeOnPage" | "executePython" | "proposePlan",
  input: unknown,
): Promise<boolean> {
  const { toSDKTool } = await import("@/lib/agent/agent-transport");
  const tools = await import("@/lib/agent/tools");

  let sdkTool;
  if (toolKey === "executeOnPage") {
    sdkTool = toSDKTool(tools.executeOnPageTool, "executeOnPage");
  } else if (toolKey === "executePython") {
    sdkTool = toSDKTool(tools.createPythonTool(), "executePython");
  } else {
    sdkTool = toSDKTool(tools.proposePlanTool, "proposePlan");
  }
  const fn = sdkTool.needsApproval as (
    i: unknown,
    o: { toolCallId: string; messages: unknown[] },
  ) => Promise<boolean> | boolean;
  return Promise.resolve(fn(input, { toolCallId: "c", messages: [] }));
}

beforeEach(() => {
  // Fresh IDB + chatDb singleton per test.
  indexedDB = new IDBFactory();
  installChromeStub();
});

afterEach(async () => {
  const { chatDb } = await import("@/lib/chat-db");
  const { tabRegistry } = await import("@/lib/agent/tab-registry");
  chatDb._resetForTests();
  tabRegistry.__resetForTests?.();
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("plan-mode gating — proposePlan is always approve-gated", () => {
  it("proposePlan in Plan mode requires approval", async () => {
    await seedConversation({ mode: "plan" });
    const out = await needsApprovalForTool("proposePlan", {
      goal: "g",
      sites: [],
      todos: [],
      allowNetwork: false,
    });
    expect(out).toBe(true);
  });

  it("proposePlan in Ask mode also requires approval (existing behavior)", async () => {
    await seedConversation({ mode: "ask" });
    const out = await needsApprovalForTool("proposePlan", {
      goal: "g",
      sites: [],
      todos: [],
      allowNetwork: false,
    });
    expect(out).toBe(true);
  });
});

describe("plan-mode gating — Plan mode without an approved plan", () => {
  it("blocks all gated tools except proposePlan (which itself is gated)", async () => {
    const { planHandle } = await seedConversation({ mode: "plan" });

    // executeOnPage write → gated (no plan, can't be in-plan).
    const writeOut = await needsApprovalForTool("executeOnPage", {
      tab: planHandle,
      kind: "write",
      code: "return 1;",
    });
    expect(writeOut).toBe(true);

    // proposePlan → also gated (always approval-gated; the user reviews
    // and Approves to set the plan).
    const proposeOut = await needsApprovalForTool("proposePlan", {
      goal: "g",
      sites: [],
      todos: [],
      allowNetwork: false,
    });
    expect(proposeOut).toBe(true);
  });
});

describe("plan-mode gating — Plan mode with approved plan", () => {
  it("skips approval for in-plan executeOnPage call", async () => {
    const { planHandle } = await seedConversation({
      mode: "plan",
      plan: {
        goal: "test",
        sites: [PLAN_SITE],
        allowNetwork: false,
        approvedAt: Date.now(),
        extensions: [],
      },
    });
    const out = await needsApprovalForTool("executeOnPage", {
      tab: planHandle,
      kind: "write",
      code: "return 1;",
    });
    expect(out).toBe(false);
  });

  it("requires approval for off-plan executeOnPage call (different origin)", async () => {
    const { offHandle } = await seedConversation({
      mode: "plan",
      plan: {
        goal: "test",
        sites: [PLAN_SITE],
        allowNetwork: false,
        approvedAt: Date.now(),
        extensions: [],
      },
    });
    // Tab handle resolves to OFF_SITE (NOT in plan).
    const out = await needsApprovalForTool("executeOnPage", {
      tab: offHandle,
      kind: "write",
      code: "return 1;",
    });
    expect(out).toBe(true);
  });

  it("requires approval when the tab handle is unknown (fail closed)", async () => {
    // Stale-handle scenario: the agent passes a handle that doesn't
    // resolve. Defaulting to in-plan would silently run the tool on
    // whatever tab the agent thinks it's targeting; we fail closed
    // so the user is prompted, matching Ask mode's behavior on the
    // same input.
    await seedConversation({
      mode: "plan",
      plan: {
        goal: "test",
        sites: [PLAN_SITE],
        allowNetwork: false,
        approvedAt: Date.now(),
        extensions: [],
      },
    });
    const out = await needsApprovalForTool("executeOnPage", {
      tab: "t-bogus", // never registered
      kind: "write",
      code: "return 1;",
    });
    expect(out).toBe(true);
  });

  it("skips approval for executePython without network access (in-plan)", async () => {
    await seedConversation({
      mode: "plan",
      plan: {
        goal: "test",
        sites: [],
        allowNetwork: false,
        approvedAt: Date.now(),
        extensions: [],
      },
    });
    const out = await needsApprovalForTool("executePython", {
      code: "1",
      allow_network: false,
    });
    expect(out).toBe(false);
  });

  it("requires approval for executePython with network when plan disallows", async () => {
    await seedConversation({
      mode: "plan",
      plan: {
        goal: "test",
        sites: [],
        allowNetwork: false,
        approvedAt: Date.now(),
        extensions: [],
      },
    });
    const out = await needsApprovalForTool("executePython", {
      code: "1",
      allow_network: true,
    });
    expect(out).toBe(true);
  });
});

describe("plan-mode gating — Act mode", () => {
  it("skips approval for any gated tool (no plan)", async () => {
    const { offHandle } = await seedConversation({ mode: "act" });
    // Off-allowlist origin — would normally gate in Ask mode.
    const out = await needsApprovalForTool("executeOnPage", {
      tab: offHandle,
      kind: "write",
      code: "return 1;",
    });
    expect(out).toBe(false);
  });

  it("still requires approval for executePython with network when plan disallows", async () => {
    await seedConversation({
      mode: "act",
      plan: {
        goal: "test",
        sites: [],
        allowNetwork: false,
        approvedAt: Date.now(),
        extensions: [],
      },
    });
    const out = await needsApprovalForTool("executePython", {
      code: "1",
      allow_network: true,
    });
    expect(out).toBe(true);
  });

  it("ALWAYS requires approval for proposePlan even in Act mode (security: no silent plan replacement)", async () => {
    // Without this gate, the model could mint a fresh plan with arbitrary
    // sites + allowNetwork in Act mode without user confirmation, then
    // call any tab tool — those calls would skip approval (Act mode) AND
    // be in-plan, broadening the agent's boundary unilaterally.
    await seedConversation({ mode: "act" });
    const out = await needsApprovalForTool("proposePlan", {
      goal: "g",
      sites: ["https://attacker.example"],
      todos: [],
      allowNetwork: true,
    });
    expect(out).toBe(true);
  });

  it("ALWAYS requires approval for proposePlan in Act mode WITH an existing plan (regression)", async () => {
    await seedConversation({
      mode: "act",
      plan: {
        goal: "test",
        sites: ["https://approved.example"],
        allowNetwork: false,
        approvedAt: Date.now(),
        extensions: [],
      },
    });
    const out = await needsApprovalForTool("proposePlan", {
      goal: "replacement",
      sites: ["https://attacker.example"],
      todos: [],
      allowNetwork: true,
    });
    expect(out).toBe(true);
  });
});

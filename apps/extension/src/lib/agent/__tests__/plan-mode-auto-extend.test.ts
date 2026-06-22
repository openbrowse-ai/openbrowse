/**
 * Integration test for the Plan-mode auto-extend hook in `toSDKTool`'s
 * `execute` wrapper (apps/extension/src/lib/agent/agent-transport.ts).
 *
 * The pure decision function `planExtensionForCall` is unit-tested in
 * `plan-store.test.ts`; this test locks down the WRAPPER-level glue:
 *
 *   resolveModeAndPlan() → planExtensionForCall(...) → extendPlanWithSite
 *     → savePlanExtensionMarker → chatDb.saveMessage(data-plan-extension)
 *
 * We invoke the SDK-wrapped tool's `execute` with Plan mode + a plan
 * that does NOT include the target origin, then assert:
 *
 *   1. The conversation's `plan.sites` now includes the new origin.
 *   2. The conversation's `plan.extensions` has a new `kind: "site"` entry.
 *   3. A new chat message with a `data-plan-extension` part was saved.
 *
 * The inner tool body is a no-op stub — what we're testing is the
 * wrapper's hook, not any specific tool's logic.
 */

import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { BrowserTool } from "../types";

const ORIGIN_ON_PLAN = "https://known.example";
const ORIGIN_OFF_PLAN = "https://newly-visited.example";
const TAB_ID = 99;
const CID = "conv-plan-auto-extend";

function installChromeStub(tabUrl: string) {
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
      get: (id: number) =>
        Promise.resolve({
          id,
          url: tabUrl,
          title: "Test",
          favIconUrl: undefined,
        }),
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
 * A trivial tab tool that does nothing in its body — we only care that
 * the WRAPPER ran. Marked as a member of TAB_INTERACTING_TOOLS by
 * passing `toolKey: "executeOnPage"` to toSDKTool, so the wrapper
 * resolves the `tab` arg and the auto-extend hook engages on Plan mode.
 */
const stubTool: BrowserTool<{ tab: string }, { ok: true }> = {
  name: "stub",
  description: "no-op for tests",
  parameters: z.object({ tab: z.string() }),
  execute: async () => ({ ok: true }),
  approval: { required: true },
};

describe("Plan-mode auto-extend hook (toSDKTool execute wrapper integration)", () => {
  beforeEach(() => {
    indexedDB = new IDBFactory();
    installChromeStub(`${ORIGIN_OFF_PLAN}/some/path`);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("extends plan + emits a data-plan-extension marker when a Plan-mode call hits an off-plan site", async () => {
    const { chatDb } = await import("@/lib/chat-db");
    const { setAgentContext, toSDKTool } = await import(
      "@/lib/agent/agent-transport"
    );
    const { getOrCreateHandle } = await import("@/lib/agent/tab-handles");
    const { tabRegistry } = await import("@/lib/agent/tab-registry");
    chatDb._resetForTests();

    // Seed conversation with Plan mode + a plan that does NOT include
    // ORIGIN_OFF_PLAN. The hook should extend on first contact.
    await chatDb.createConversation({
      id: CID,
      title: "test",
      spaceId: null,
      ownedGroupId: null,
      ownedLtids: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      mode: "plan",
      plan: {
        goal: "test",
        sites: [ORIGIN_ON_PLAN],
        allowNetwork: false,
        approvedAt: 1000,
        extensions: [],
      },
    });

    setAgentContext(CID);

    // Mint a tab handle that resolves to a tab on ORIGIN_OFF_PLAN.
    const ltid = tabRegistry.registerExisting(TAB_ID);
    const handle = getOrCreateHandle(CID, ltid);

    // Wrap the stub as if it were `executeOnPage` (in TAB_INTERACTING_TOOLS).
    // The wrapper will:
    //   1. Read mode/plan from chatDb (Plan + the seeded plan)
    //   2. Resolve the tab → ORIGIN_OFF_PLAN
    //   3. planExtensionForCall returns { kind: "site", origin: ORIGIN_OFF_PLAN }
    //   4. Call extendPlanWithSite + savePlanExtensionMarker
    //   5. Run the stub body
    const sdkTool = toSDKTool(stubTool, "executeOnPage") as unknown as {
      execute: (
        input: unknown,
        opts: { toolCallId: string },
      ) => Promise<unknown>;
    };

    const beforeMs = Date.now();
    const result = await sdkTool.execute(
      { tab: handle },
      { toolCallId: "call-1" },
    );

    expect(result).toEqual({ ok: true });

    // 1. Plan was extended with the new origin.
    const conv = await chatDb.getConversation(CID);
    expect(conv?.plan?.sites).toContain(ORIGIN_ON_PLAN);
    expect(conv?.plan?.sites).toContain(ORIGIN_OFF_PLAN);

    // 2. Extensions log has a new `kind: "site"` entry.
    const exts = conv?.plan?.extensions ?? [];
    expect(exts).toHaveLength(1);
    expect(exts[0]).toMatchObject({
      kind: "site",
      site: ORIGIN_OFF_PLAN,
    });
    expect(exts[0].extendedAt).toBeGreaterThanOrEqual(beforeMs);

    // 3. A `data-plan-extension` marker message was saved to the
    //    conversation. The compacting transport strips this before the
    //    LLM sees it; here we verify it landed in chatDb so the chat
    //    UI can render the inline notice.
    const messages = await chatDb.getMessages(CID);
    const marker = messages.find((m) =>
      m.parts?.some((p) => p.type === "data-plan-extension"),
    );
    expect(marker).toBeTruthy();
    const part = marker!.parts!.find((p) => p.type === "data-plan-extension");
    expect(part).toMatchObject({
      type: "data-plan-extension",
      data: { kind: "site", origin: ORIGIN_OFF_PLAN },
    });
  });

  it("does NOT extend the plan when the call's origin is already in plan.sites", async () => {
    // Re-stub chrome so the tab URL is on the plan this time. (afterEach
    // unstubs; we need a fresh stub mid-describe to change the tab URL.)
    vi.unstubAllGlobals();
    installChromeStub(`${ORIGIN_ON_PLAN}/already/here`);

    const { chatDb } = await import("@/lib/chat-db");
    const { setAgentContext, toSDKTool } = await import(
      "@/lib/agent/agent-transport"
    );
    const { getOrCreateHandle } = await import("@/lib/agent/tab-handles");
    const { tabRegistry } = await import("@/lib/agent/tab-registry");
    chatDb._resetForTests();

    await chatDb.createConversation({
      id: CID,
      title: "test",
      spaceId: null,
      ownedGroupId: null,
      ownedLtids: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      mode: "plan",
      plan: {
        goal: "test",
        sites: [ORIGIN_ON_PLAN],
        allowNetwork: false,
        approvedAt: 1000,
        extensions: [],
      },
    });

    setAgentContext(CID);
    const ltid = tabRegistry.registerExisting(TAB_ID);
    const handle = getOrCreateHandle(CID, ltid);

    const sdkTool = toSDKTool(stubTool, "executeOnPage") as unknown as {
      execute: (
        input: unknown,
        opts: { toolCallId: string },
      ) => Promise<unknown>;
    };
    await sdkTool.execute({ tab: handle }, { toolCallId: "call-2" });

    // No extension recorded.
    const conv = await chatDb.getConversation(CID);
    expect(conv?.plan?.sites).toEqual([ORIGIN_ON_PLAN]);
    expect(conv?.plan?.extensions ?? []).toEqual([]);

    // No marker message saved.
    const messages = await chatDb.getMessages(CID);
    const marker = messages.find((m) =>
      m.parts?.some((p) => p.type === "data-plan-extension"),
    );
    expect(marker).toBeUndefined();
  });
});

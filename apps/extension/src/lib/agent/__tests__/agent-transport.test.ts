/**
 * Tests for the `toSDKTool` wrapper in agent-transport.ts.
 *
 * Focus is on the abortSignal-propagation contract added so that
 * clicking Stop while a subagent is running actually cancels the
 * subagent. The SDK passes `options.abortSignal` to every tool's
 * execute(); the wrapper must stamp it onto `ctx.signal` so tools
 * (most importantly `delegate`) can forward it downstream.
 *
 * Other wrapper concerns (approval gating, tab resolution, image
 * outputs) are exercised via integration paths; this file scopes
 * itself to the signal plumbing.
 */

import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { z } from "zod";
import { toSDKTool, setAgentContext } from "../agent-transport";
import type { BrowserTool } from "../types";
import type { ToolContext } from "../driver";
import { tabRegistry } from "../tab-registry";
import { getOrCreateHandle, clearHandles } from "../tab-handles";
import { __test_reset as resetCapture } from "../cdp-capture";

function makeMinimalContext(): ToolContext {
  return {
    // Driver is unused in these tests — the wrapper only touches it via
    // the inner tool's execute, which we replace with a recorder.
    driver: {} as ToolContext["driver"],
    session: { conversationId: null },
  };
}

function makeRecordingTool(): {
  tool: BrowserTool<{ x: string }, { ok: boolean }>;
  received: { ctx: ToolContext | null; resolve?: () => void };
} {
  const received: { ctx: ToolContext | null; resolve?: () => void } = { ctx: null };
  const tool: BrowserTool<{ x: string }, { ok: boolean }> = {
    name: "recordingTool",
    description: "Records the ctx it receives",
    parameters: z.object({ x: z.string() }),
    execute: async (_input, ctx) => {
      received.ctx = ctx;
      await new Promise<void>(r => { received.resolve = r; });
      return { ok: true };
    },
  };
  return { tool, received };
}

describe("toSDKTool — abortSignal propagation", () => {
  it("forwards a linked abortSignal to ctx.signal so delegate can cancel", async () => {
    const { tool, received } = makeRecordingTool();
    const wrapped = toSDKTool(tool, "recordingTool");

    const controller = new AbortController();
    const baseCtx = makeMinimalContext();

    const executePromise = (
      wrapped.execute as unknown as (
        input: { x: string },
        options: {
          toolCallId: string;
          experimental_context?: unknown;
          abortSignal?: AbortSignal;
        },
      ) => Promise<unknown>
    )(
      { x: "hello" },
      {
        toolCallId: "tc_1",
        abortSignal: controller.signal,
        experimental_context: baseCtx,
      },
    );

    // wait for tool to receive execution
    await new Promise(r => setTimeout(r, 0));

    expect(received.ctx?.signal).toBeDefined();
    expect(received.ctx?.signal?.aborted).toBe(false);
    expect(received.ctx?.toolCallId).toBe("tc_1");
    
    // Test that the linked signal aborts when the parent aborts
    controller.abort();
    expect(received.ctx?.signal?.aborted).toBe(true);
    
    received.resolve?.();
    await executePromise;
  });

  it("provides its own ctx.signal even when the SDK does not provide one (so UI can still cancel)", async () => {
    const { tool, received } = makeRecordingTool();
    const wrapped = toSDKTool(tool, "recordingTool");

    const baseCtx = makeMinimalContext();

    const executePromise = (
      wrapped.execute as unknown as (
        input: { x: string },
        options: {
          toolCallId: string;
          experimental_context?: unknown;
          abortSignal?: AbortSignal;
        },
      ) => Promise<unknown>
    )(
      { x: "hello" },
      {
        toolCallId: "tc_3",
        experimental_context: baseCtx,
      },
    );

    // wait for tool to receive execution
    await new Promise(r => setTimeout(r, 0));

    expect(received.ctx?.signal).toBeDefined();
    
    received.resolve?.();
    await executePromise;
  });
});

/**
 * Capture lifecycle, post-bug-fix.
 *
 * Original behavior: `notifyAgentStatus(true, …, tabId)` started capture
 * fire-and-forget, only when `resolveTabFromInput(input.tab)` succeeded.
 * Two failure modes followed:
 *
 *  1. `navigate` (and any tab-producing tool) called without a `tab` field
 *     created a new tab whose page-load network/console events were missed
 *     entirely — capture only armed on the *next* tool call against that
 *     handle.
 *  2. Even when `input.tab` resolved, capture was started but not awaited,
 *     so the tool's own network activity raced the async
 *     `chrome.debugger.attach + Network.enable + Runtime.enable` round-trip.
 *
 * The fix:
 *   - Pre-execute: when `resolveTabFromInput` yields a tabId, AWAIT
 *     `startCapture(tabId)` before calling `t.execute`. Idempotent for
 *     already-tracked tabs, so the cost is ~one CDP round-trip on first
 *     touch only.
 *   - Post-execute: if the tool's result includes a string `tab` handle and
 *     no `error`, resolve that handle and `await startCapture` for it. This
 *     covers tab-producing tools (notably `navigate` with no input handle).
 *
 * These tests assert both branches via `chrome.debugger.attach`'s call
 * record, since `startCapture`'s observable side effect is the attach call.
 */
describe("toSDKTool — capture lifecycle", () => {
  let attachSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    resetCapture();
    setAgentContext("cid-test");
    // chrome stubs: spy on debugger.attach so we can see startCapture's
    // round-trip; chrome.tabs.get must resolve so resolveTabFromInput
    // returns a non-null tab.
    attachSpy = vi.fn(() => Promise.resolve());
    const tabsGetByCtid = new Map<number, chrome.tabs.Tab>();
    const fakeChrome = {
      ...(globalThis as { chrome: Record<string, unknown> }).chrome,
      debugger: {
        ...(globalThis as { chrome: { debugger: Record<string, unknown> } }).chrome.debugger,
        attach: attachSpy,
        sendCommand: vi.fn(() => Promise.resolve({})),
        detach: vi.fn(() => Promise.resolve()),
      },
      tabs: {
        ...(globalThis as { chrome: { tabs: Record<string, unknown> } }).chrome.tabs,
        get: vi.fn((id: number) => {
          const t = tabsGetByCtid.get(id);
          return t
            ? Promise.resolve(t)
            : Promise.reject(new Error(`No tab with id ${id}`));
        }),
      },
    };
    vi.stubGlobal("chrome", fakeChrome);
    // Expose the tab registry to the test for setup.
    (globalThis as unknown as { __tabsByCtid: Map<number, chrome.tabs.Tab> }).__tabsByCtid =
      tabsGetByCtid;
  });

  afterEach(() => {
    resetCapture();
    setAgentContext(null);
    clearHandles("cid-test");
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  /** Helper: register a Chrome tab id under a fresh handle in the
   *  current conversation, return the handle string. */
  function registerTabHandle(ctid: number, url = "https://example.com"): string {
    const ltid = tabRegistry.registerExisting(ctid);
    const handle = getOrCreateHandle("cid-test", ltid);
    (globalThis as unknown as { __tabsByCtid: Map<number, chrome.tabs.Tab> }).__tabsByCtid.set(
      ctid,
      { id: ctid, url, title: "x", active: false } as chrome.tabs.Tab,
    );
    return handle;
  }

  it("awaits startCapture for input.tab BEFORE the tool's execute runs", async () => {
    const handle = registerTabHandle(123);
    let attachCallsAtExecute = -1;
    const tool: BrowserTool<{ tab: string }, { ok: boolean }> = {
      name: "snapshot",
      description: "x",
      parameters: z.object({ tab: z.string() }),
      execute: async () => {
        // Snapshot the call count from inside execute. If startCapture
        // wasn't awaited first, this would be 0.
        attachCallsAtExecute = attachSpy.mock.calls.length;
        return { ok: true };
      },
    };
    const wrapped = toSDKTool(tool, "snapshot");

    await (
      wrapped.execute as unknown as (
        input: { tab: string },
        opts: { toolCallId: string; experimental_context?: unknown },
      ) => Promise<unknown>
    )(
      { tab: handle },
      { toolCallId: "tc_cap1", experimental_context: makeMinimalContext() },
    );

    expect(attachCallsAtExecute).toBe(1);
    expect(attachSpy.mock.calls[0]?.[0]).toEqual({ tabId: 123 });
  });

  it("starts capture for a tab returned in the tool's result (e.g. navigate created a new tab)", async () => {
    // No input handle — simulating `navigate({ url })` with no tab field.
    // The tool's result carries the produced handle.
    const newCtid = 456;
    const newHandle = registerTabHandle(newCtid);

    const tool: BrowserTool<{ url: string }, { tab: string; navigated: boolean }> = {
      name: "navigate",
      description: "x",
      parameters: z.object({ url: z.string() }),
      execute: async () => ({ tab: newHandle, navigated: true }),
    };
    const wrapped = toSDKTool(tool, "navigate");

    await (
      wrapped.execute as unknown as (
        input: { url: string },
        opts: { toolCallId: string; experimental_context?: unknown },
      ) => Promise<unknown>
    )(
      { url: "https://example.com" },
      { toolCallId: "tc_cap2", experimental_context: makeMinimalContext() },
    );

    // attach should have fired exactly once, for the new tab returned in
    // the result. (Pre-fix: zero attach calls — the bug.)
    expect(attachSpy.mock.calls.map((c) => c[0])).toEqual([{ tabId: newCtid }]);
  });

  it("does NOT start capture for a result tab when the result reports an error", async () => {
    const ctid = 789;
    const handle = registerTabHandle(ctid);

    const tool: BrowserTool<{ url: string; tab?: string }, { tab: string; navigated: boolean; error: string }> = {
      name: "navigate",
      description: "x",
      parameters: z.object({ url: z.string(), tab: z.string().optional() }),
      execute: async () => ({ tab: handle, navigated: false, error: "Failed" }),
    };
    const wrapped = toSDKTool(tool, "navigate");

    await (
      wrapped.execute as unknown as (
        input: { url: string },
        opts: { toolCallId: string; experimental_context?: unknown },
      ) => Promise<unknown>
    )(
      { url: "https://example.com" },
      { toolCallId: "tc_cap3", experimental_context: makeMinimalContext() },
    );

    // Pre-execute path: no input.tab → no pre-attach.
    // Post-execute path: result has `error` → no post-attach.
    expect(attachSpy.mock.calls).toHaveLength(0);
  });

  it("does not double-attach when input.tab and result.tab are the same handle", async () => {
    const ctid = 321;
    const handle = registerTabHandle(ctid);

    const tool: BrowserTool<{ tab: string }, { tab: string; ok: boolean }> = {
      name: "clickElement",
      description: "x",
      parameters: z.object({ tab: z.string() }),
      execute: async ({ tab }) => ({ tab, ok: true }),
    };
    const wrapped = toSDKTool(tool, "clickElement");

    await (
      wrapped.execute as unknown as (
        input: { tab: string },
        opts: { toolCallId: string; experimental_context?: unknown },
      ) => Promise<unknown>
    )(
      { tab: handle },
      { toolCallId: "tc_cap4", experimental_context: makeMinimalContext() },
    );

    // Pre-execute attaches once; post-execute is a no-op because the
    // tab is already tracked (startCapture is idempotent).
    expect(attachSpy.mock.calls).toHaveLength(1);
    expect(attachSpy.mock.calls[0]?.[0]).toEqual({ tabId: ctid });
  });

  /**
   * Regression for the user-reported "Cannot attach debugger to tab N:
   * Another debugger is already attached to the tab with id: N." error.
   *
   * Reproduction sequence (matches the failing chat trace):
   *   1. Pre-execute startCapture (added in our recent fix) attaches via
   *      cdp-capture.
   *   2. The tool's body issues a CDP command via cdp-session.sendCommand,
   *      which internally calls chrome.debugger.attach a SECOND time.
   *   3. Chrome rejects the second attach with the message above.
   *
   * Pre-architecture-fix: cdp-session and cdp-capture have separate session
   * maps + separate chrome.debugger.attach calls. The second attach throws,
   * cdp-session's defensive `msg.includes("Already attached")` guard MISSES
   * (Chrome's message is lowercase "already attached"), and the tool fails.
   *
   * Post-architecture-fix: cdp-session is the single owner of debugger
   * state. cdp-capture.startCapture goes through cdp-session.attach (with
   * a refcount), so cdp-session.sendCommand finds the existing session,
   * skips the second attach call, and the tool succeeds. chrome.debugger.
   * attach is called exactly once across both code paths.
   */
  it("does not double-attach when capture armed first then a cdp-session-using tool runs", async () => {
    // Make the second chrome.debugger.attach reject with Chrome's REAL error
    // message. After the architecture fix, this rejection path is never hit.
    let attachCallCount = 0;
    attachSpy.mockImplementation(() => {
      attachCallCount++;
      if (attachCallCount === 1) return Promise.resolve();
      return Promise.reject(
        new Error(
          `Another debugger is already attached to the tab with id: ${999}.`,
        ),
      );
    });

    const ctid = 999;
    const handle = registerTabHandle(ctid);

    // Tool that uses cdp-session.sendCommand internally (the same path
    // `snapshot`, `clickElement`, etc. take). We import sendCommand here so
    // the test exercises the real cdp-session attach machinery.
    const { sendCommand } = await import("../cdp-session");
    const tool: BrowserTool<{ tab: string }, { ok: boolean }> = {
      name: "snapshot",
      description: "x",
      parameters: z.object({ tab: z.string() }),
      execute: async ({ tab: _tab }) => {
        await sendCommand(ctid, "DOM.getDocument");
        return { ok: true };
      },
    };
    const wrapped = toSDKTool(tool, "snapshot");

    const result = await (
      wrapped.execute as unknown as (
        input: { tab: string },
        opts: { toolCallId: string; experimental_context?: unknown },
      ) => Promise<{ ok: boolean }>
    )(
      { tab: handle },
      { toolCallId: "tc_collide", experimental_context: makeMinimalContext() },
    );

    // Tool succeeds end-to-end: no double-attach throw.
    expect(result).toEqual({ ok: true });
    // Exactly one attach across cdp-capture + cdp-session.
    expect(attachSpy.mock.calls).toHaveLength(1);
    expect(attachSpy.mock.calls[0]?.[0]).toEqual({ tabId: ctid });
  });
});

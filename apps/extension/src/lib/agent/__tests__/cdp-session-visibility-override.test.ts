/**
 * Background-tab throttle override in `cdp-session.attach`.
 *
 * Every CDP-attached tab should immediately receive
 * `Emulation.setPageVisibilityOverride { visibility: "visible" }` and
 * `Page.setWebLifecycleState { state: "active" }` so Chrome stops
 * throttling rAF/timers/lifecycle on the worked tab when the agent's host
 * (home.html / newtab.html / side panel) is not focused on it.
 *
 * Without this, the agent's `clickElement` tool stalls indefinitely until
 * the user manually focuses the worked tab — see
 * `viewport.waitForLayoutFlush` for the rAF wait that wedges. These tests
 * pin down:
 *
 *   1. Both commands are issued on attach, in order, with the right params.
 *   2. Failures of either command are swallowed (some targets reject the
 *      override; the attach must still succeed).
 *   3. The override is applied exactly once per attach (not on every
 *      sendCommand round-trip).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface SendCall {
  method: string;
  params: unknown;
}

function stubChrome(opts: {
  visibilityFails?: boolean;
  lifecycleFails?: boolean;
} = {}): {
  attachCalls: number[];
  sendCalls: SendCall[];
} {
  const attachCalls: number[] = [];
  const sendCalls: SendCall[] = [];
  vi.stubGlobal("chrome", {
    tabs: {
      onRemoved: { addListener: () => {} },
      onReplaced: { addListener: () => {} },
      onUpdated: { addListener: () => {} },
      onActivated: { addListener: () => {} },
      onCreated: { addListener: () => {} },
      get: () => Promise.resolve({ id: 1, url: "" }),
    },
    debugger: {
      onDetach: { addListener: () => {} },
      onEvent: { addListener: () => {} },
      attach: vi.fn((target: { tabId: number }) => {
        attachCalls.push(target.tabId);
        return Promise.resolve();
      }),
      detach: vi.fn(() => Promise.resolve()),
      sendCommand: vi.fn(
        (_target: { tabId: number }, method: string, params: unknown) => {
          sendCalls.push({ method, params });
          if (
            opts.visibilityFails &&
            method === "Emulation.setPageVisibilityOverride"
          ) {
            return Promise.reject(
              new Error("override unsupported on this target"),
            );
          }
          if (opts.lifecycleFails && method === "Page.setWebLifecycleState") {
            return Promise.reject(new Error("lifecycle unsupported"));
          }
          return Promise.resolve({});
        },
      ),
    },
  });
  return { attachCalls, sendCalls };
}

describe("cdp-session.attach: background-tab throttle override", () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("issues setPageVisibilityOverride + setWebLifecycleState immediately after attach", async () => {
    const { attachCalls, sendCalls } = stubChrome();
    const { attach } = await import("../cdp-session");
    const { tabRegistry } = await import("../tab-registry");
    tabRegistry.__resetForTests!();

    await attach(42);

    expect(attachCalls).toEqual([42]);
    // Both override commands were issued (order: visibility first, then
    // lifecycle), with the correct params.
    const overrideMethods = sendCalls
      .filter(
        (c) =>
          c.method === "Emulation.setPageVisibilityOverride" ||
          c.method === "Page.setWebLifecycleState",
      )
      .map((c) => c.method);
    expect(overrideMethods).toEqual([
      "Emulation.setPageVisibilityOverride",
      "Page.setWebLifecycleState",
    ]);

    const visCall = sendCalls.find(
      (c) => c.method === "Emulation.setPageVisibilityOverride",
    );
    expect(visCall?.params).toEqual({ visibility: "visible" });

    const lifeCall = sendCalls.find(
      (c) => c.method === "Page.setWebLifecycleState",
    );
    expect(lifeCall?.params).toEqual({ state: "active" });
  });

  it("swallows setPageVisibilityOverride failures and still installs the session", async () => {
    const { sendCalls } = stubChrome({ visibilityFails: true });
    const { attach, sendCommand } = await import("../cdp-session");
    const { tabRegistry } = await import("../tab-registry");
    tabRegistry.__resetForTests!();

    // attach must NOT throw even though setPageVisibilityOverride rejects.
    const session = await attach(42);
    expect(session.attached).toBe(true);

    // Lifecycle command still runs even though visibility failed (each
    // override is independently best-effort).
    const lifeCall = sendCalls.find(
      (c) => c.method === "Page.setWebLifecycleState",
    );
    expect(lifeCall).toBeDefined();

    // Subsequent sendCommand calls work normally — proves the session is
    // healthy after a failed override.
    await expect(sendCommand(42, "Runtime.evaluate", { expression: "1" }))
      .resolves.toBeDefined();
  });

  it("swallows setWebLifecycleState failures and still installs the session", async () => {
    const { sendCalls } = stubChrome({ lifecycleFails: true });
    const { attach, sendCommand } = await import("../cdp-session");
    const { tabRegistry } = await import("../tab-registry");
    tabRegistry.__resetForTests!();

    const session = await attach(42);
    expect(session.attached).toBe(true);

    // Visibility command still ran.
    const visCall = sendCalls.find(
      (c) => c.method === "Emulation.setPageVisibilityOverride",
    );
    expect(visCall).toBeDefined();

    await expect(sendCommand(42, "Runtime.evaluate", { expression: "1" }))
      .resolves.toBeDefined();
  });

  it("applies the override exactly once per attach (idempotent attach => idempotent override)", async () => {
    const { sendCalls } = stubChrome();
    const { attach } = await import("../cdp-session");
    const { tabRegistry } = await import("../tab-registry");
    tabRegistry.__resetForTests!();

    // Three attaches in a row — only the first does the chrome.debugger.attach
    // round-trip; the rest are no-ops. Override commands must follow the
    // same shape: one set per real attach, not per logical attach() call.
    await attach(42);
    await attach(42);
    await attach(42);

    const visCount = sendCalls.filter(
      (c) => c.method === "Emulation.setPageVisibilityOverride",
    ).length;
    const lifeCount = sendCalls.filter(
      (c) => c.method === "Page.setWebLifecycleState",
    ).length;
    expect(visCount).toBe(1);
    expect(lifeCount).toBe(1);
  });
});

/**
 * Targeted tests for `cdp-session`'s registry integration: when the
 * `tab-registry` emits `onReplace` / `onRemove`, the corresponding ctid's
 * cached Session is dropped so the next `sendCommand` re-attaches against
 * the live tab.
 *
 * These tests do NOT exercise the full `sendCommand` path (which would
 * require a much heavier `chrome.debugger` mock) — they assert on the
 * exported sessions map's emptiness via the indirect signal of a fresh
 * attach call.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("cdp-session: registry-driven invalidation", () => {
  // We dynamic-import inside each test so the module's top-level chrome
  // listener registrations re-run against a fresh stubbed `chrome`.
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("drops the cached session for oldCtid when the registry fires onReplace", async () => {
    const attachCalls: number[] = [];
    const sendCommandCalls: { tabId: number; method: string }[] = [];
    vi.stubGlobal("chrome", {
      tabs: {
        onRemoved: { addListener: () => {}, removeListener: () => {} },
        onReplaced: { addListener: () => {}, removeListener: () => {} },
        onUpdated: { addListener: () => {}, removeListener: () => {} },
        onActivated: { addListener: () => {}, removeListener: () => {} },
        onCreated: { addListener: () => {}, removeListener: () => {} },
        get: () => Promise.resolve({ id: 1, url: "https://x" }),
      },
      debugger: {
        onDetach: { addListener: () => {}, removeListener: () => {} },
        onEvent: { addListener: () => {}, removeListener: () => {} },
        attach: vi.fn((target: { tabId: number }) => {
          attachCalls.push(target.tabId);
          return Promise.resolve();
        }),
        detach: vi.fn(() => Promise.resolve()),
        sendCommand: vi.fn(
          (target: { tabId: number }, method: string) => {
            sendCommandCalls.push({ tabId: target.tabId, method });
            return Promise.resolve({});
          },
        ),
      },
    });

    const { sendCommand } = await import("../cdp-session");
    const { tabRegistry } = await import("../tab-registry");
    tabRegistry.__resetForTests!();

    // First call attaches against ctid 100.
    await sendCommand(100, "Page.bringToFront");
    expect(attachCalls).toContain(100);
    const attachesBefore = attachCalls.length;

    // Register ctid 100 with the registry, then fire onReplaced 100 → 200.
    tabRegistry.registerExisting(100);
    tabRegistry.__handleReplaceForTests!(200, 100);

    // Next sendCommand against ctid 200 should attach freshly (because
    // session for 100 was dropped, AND no session exists for 200 yet).
    await sendCommand(200, "Page.bringToFront");
    expect(attachCalls).toContain(200);
    expect(attachCalls.length).toBeGreaterThan(attachesBefore);

    // Subsequent sendCommand against the OLD ctid 100 would also attach
    // (the session was dropped by onReplace), proving the cache was
    // invalidated.
    const attachesAfter200 = attachCalls.length;
    await sendCommand(100, "Page.bringToFront");
    expect(attachCalls.length).toBeGreaterThan(attachesAfter200);
  });

  it("drops the cached session for ctid when the registry fires onRemove", async () => {
    const attachCalls: number[] = [];
    vi.stubGlobal("chrome", {
      tabs: {
        onRemoved: { addListener: () => {}, removeListener: () => {} },
        onReplaced: { addListener: () => {}, removeListener: () => {} },
        onUpdated: { addListener: () => {}, removeListener: () => {} },
        onActivated: { addListener: () => {}, removeListener: () => {} },
        onCreated: { addListener: () => {}, removeListener: () => {} },
        get: () => Promise.resolve({ id: 1, url: "" }),
      },
      debugger: {
        onDetach: { addListener: () => {}, removeListener: () => {} },
        onEvent: { addListener: () => {}, removeListener: () => {} },
        attach: vi.fn((target: { tabId: number }) => {
          attachCalls.push(target.tabId);
          return Promise.resolve();
        }),
        detach: vi.fn(() => Promise.resolve()),
        sendCommand: vi.fn(() => Promise.resolve({})),
      },
    });

    const { sendCommand } = await import("../cdp-session");
    const { tabRegistry } = await import("../tab-registry");
    tabRegistry.__resetForTests!();

    await sendCommand(42, "Page.bringToFront");
    expect(attachCalls.filter((id) => id === 42).length).toBe(1);

    tabRegistry.registerExisting(42);
    tabRegistry.__handleRemoveForTests!(42);

    // Fresh attach on next call.
    await sendCommand(42, "Page.bringToFront");
    expect(attachCalls.filter((id) => id === 42).length).toBe(2);
  });
});

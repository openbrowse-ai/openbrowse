/**
 * Host-side timeout on `viewport.waitForLayoutFlush`.
 *
 * The function used to issue `Runtime.evaluate { awaitPromise: true }` with
 * an in-page Promise that waits two requestAnimationFrame callbacks. CDP
 * `Runtime.evaluate` has no `timeout` field — it's silently dropped by
 * Chrome. So when the worked tab is backgrounded, Chrome throttles rAF to
 * ~1 Hz then 0 Hz, the in-page Promise never resolves, and the CDP call
 * hangs forever — wedging `clickElement` until the user manually focuses
 * the tab.
 *
 * The fix: race the `driver.sendCommand` against a host-side `setTimeout`.
 * The function is best-effort by contract, so a timeout resolves normally
 * (the click pipeline proceeds with slightly-stale layout, which is
 * strictly better than wedging).
 *
 * This test pins down: even when `Runtime.evaluate` never resolves,
 * `waitForLayoutFlush` returns within the host-side budget.
 */

import { describe, expect, it, vi, afterEach } from "vitest";
import type { BrowserDriver } from "../driver";
import { waitForLayoutFlush } from "../viewport";

afterEach(() => {
  vi.useRealTimers();
});

function neverResolvingDriver(): BrowserDriver {
  return {
    sendCommand: vi.fn(
      () =>
        // Never resolves, never rejects — the failure mode we're guarding
        // against (rAF throttled to 0 Hz on a backgrounded tab).
        new Promise(() => {}),
    ),
  } as unknown as BrowserDriver;
}

describe("viewport.waitForLayoutFlush — host-side timeout", () => {
  it("returns within the timeout budget when Runtime.evaluate never resolves", async () => {
    vi.useFakeTimers();
    const driver = neverResolvingDriver();

    const promise = waitForLayoutFlush(driver, 1);

    // Advance past the host-side timeout (1500ms). Without the timeout
    // this would hang the test indefinitely.
    await vi.advanceTimersByTimeAsync(1600);

    // Should have resolved by now.
    await expect(promise).resolves.toBeUndefined();
  });

  it("resolves immediately when Runtime.evaluate resolves quickly (foreground happy path)", async () => {
    const driver = {
      sendCommand: vi.fn(async () => ({})),
    } as unknown as BrowserDriver;

    const start = Date.now();
    await waitForLayoutFlush(driver, 1);
    const elapsed = Date.now() - start;

    // Foreground path: should complete well under the 1500ms timeout
    // (typically <10ms — a single resolved promise).
    expect(elapsed).toBeLessThan(500);
    expect(driver.sendCommand).toHaveBeenCalledWith(
      1,
      "Runtime.evaluate",
      expect.objectContaining({
        awaitPromise: true,
        returnByValue: true,
      }),
    );
  });

  it("does NOT pass an unsupported `timeout` field to Runtime.evaluate", async () => {
    // The CDP Runtime.evaluate spec has no `timeout` field. The previous
    // implementation passed `timeout: 1000` which Chrome silently ignored
    // (and was masked as "the wait is bounded" by misleading comments).
    // We removed it; this test guards against it being added back.
    const driver = {
      sendCommand: vi.fn(async () => ({})),
    } as unknown as BrowserDriver;

    await waitForLayoutFlush(driver, 1);

    const call = (driver.sendCommand as ReturnType<typeof vi.fn>).mock.calls[0];
    const params = call[2] as Record<string, unknown>;
    expect(params).not.toHaveProperty("timeout");
  });

  it("swallows CDP errors (debugger detached, etc.) without throwing", async () => {
    const driver = {
      sendCommand: vi.fn(async () => {
        throw new Error("Detached while handling command");
      }),
    } as unknown as BrowserDriver;

    await expect(waitForLayoutFlush(driver, 1)).resolves.toBeUndefined();
  });
});

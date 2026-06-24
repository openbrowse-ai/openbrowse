import { describe, expect, it, vi } from "vitest";
import type { BrowserDriver } from "../driver";
import { captureScreenshot } from "../capture-utils";

interface Call {
  method: string;
  params: unknown;
}

function recordingDriver(opts: {
  captureFails?: number; // number of leading captureScreenshot calls that throw
  evalFails?: boolean; // make Runtime.evaluate throw
} = {}): { driver: BrowserDriver; calls: Call[] } {
  const calls: Call[] = [];
  let captureCalls = 0;
  const driver = {
    sendCommand: vi.fn(async (_tabId: unknown, method: string, params: unknown) => {
      calls.push({ method, params });
      if (method === "Runtime.evaluate") {
        if (opts.evalFails) throw new Error("no Runtime.evaluate");
        return {} as never;
      }
      if (method === "Page.captureScreenshot") {
        captureCalls++;
        if (opts.captureFails && captureCalls <= opts.captureFails) {
          throw new Error("-32000 Unable to capture screenshot");
        }
        return { data: "QUJD" } as never; // "ABC"
      }
      return {} as never;
    }),
  } as unknown as BrowserDriver;
  return { driver, calls };
}

describe("captureScreenshot — overlay hiding", () => {
  it("hides overlays, captures, then restores — in that order", async () => {
    const { driver, calls } = recordingDriver();
    const data = await captureScreenshot(driver, 1);
    expect(data).toBe("QUJD");

    const methods = calls.map((c) => c.method);
    expect(methods).toEqual([
      "Runtime.evaluate", // hide
      "Page.captureScreenshot",
      "Runtime.evaluate", // restore
    ]);
    // Hide injects the style; restore removes it.
    expect(String((calls[0].params as { expression: string }).expression)).toContain(
      "openbrowse-capture-hide",
    );
    expect(String((calls[2].params as { expression: string }).expression)).toContain(
      "remove()",
    );
  });

  it("restores overlays even when capture throws", async () => {
    const { driver, calls } = recordingDriver({ captureFails: 2 });
    await expect(captureScreenshot(driver, 1)).rejects.toThrow();
    // hide, capture(fail), capture(fail), then restore in finally.
    const methods = calls.map((c) => c.method);
    expect(methods[0]).toBe("Runtime.evaluate");
    expect(methods.at(-1)).toBe("Runtime.evaluate");
    expect(methods.filter((m) => m === "Page.captureScreenshot").length).toBe(2);
  });

  it("retries on a transient capture failure with captureBeyondViewport flipped on", async () => {
    // First call fails with -32000; retry should succeed. The retry MUST
    // pass `captureBeyondViewport: true` (the off-screen renderer path)
    // because the dominant cause of -32000 in production is a backgrounded
    // tab whose compositor isn't committing frames — captureBeyondViewport
    // doesn't depend on a fresh compositor frame.
    const { driver, calls } = recordingDriver({ captureFails: 1 });
    const data = await captureScreenshot(driver, 1);
    expect(data).toBe("QUJD");

    const captureCalls = calls.filter(
      (c) => c.method === "Page.captureScreenshot",
    );
    expect(captureCalls.length).toBe(2);

    // First attempt: caller's params (no captureBeyondViewport).
    expect(captureCalls[0].params).toEqual({ format: "png" });

    // Retry attempt: same params PLUS captureBeyondViewport: true.
    expect(captureCalls[1].params).toEqual({
      format: "png",
      captureBeyondViewport: true,
    });
  });

  it("retries WITHOUT changing params when captureBeyondViewport was already on (fullPage callers)", async () => {
    // When the caller (e.g. screenshot tool's fullPage mode) already
    // requested captureBeyondViewport, there's no further escape hatch —
    // retry with the same params.
    const { driver, calls } = recordingDriver({ captureFails: 1 });
    const params = { format: "png", captureBeyondViewport: true };
    const data = await captureScreenshot(driver, 1, params);
    expect(data).toBe("QUJD");

    const captureCalls = calls.filter(
      (c) => c.method === "Page.captureScreenshot",
    );
    expect(captureCalls.length).toBe(2);
    expect(captureCalls[0].params).toEqual(params);
    expect(captureCalls[1].params).toEqual(params);
  });

  it("still captures when overlay hide/restore is unavailable", async () => {
    const { driver } = recordingDriver({ evalFails: true });
    // Runtime.evaluate throws for both hide and restore, but capture proceeds.
    const data = await captureScreenshot(driver, 1);
    expect(data).toBe("QUJD");
  });

  it("forwards capture params (e.g. fullPage clip)", async () => {
    const { driver, calls } = recordingDriver();
    const params = { format: "png", captureBeyondViewport: true };
    await captureScreenshot(driver, 1, params);
    const capture = calls.find((c) => c.method === "Page.captureScreenshot");
    expect(capture?.params).toEqual(params);
  });
});

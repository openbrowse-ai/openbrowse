import { describe, expect, it, vi } from "vitest";
import type { BrowserDriver } from "../../driver";
import { captureNormalizedShot, captureRegionShot } from "../screenshot";

function fakeDriver(): BrowserDriver {
  return {
    sendCommand: vi.fn(async (_t: unknown, method: string) => {
      if (method === "Page.captureScreenshot") return { data: "QUJD" } as never; // "ABC"
      return {} as never;
    }),
  } as unknown as BrowserDriver;
}

describe("captureNormalizedShot", () => {
  it("returns a data URL from the captured base64 (no-canvas fallback)", async () => {
    // In the test environment OffscreenCanvas/createImageBitmap are absent, so
    // the function returns the raw capture unchanged. The resize path itself
    // is exercised in the browser; here we lock in the fallback contract.
    const url = await captureNormalizedShot(fakeDriver(), 1, 1280, 800);
    expect(url).toBe("data:image/png;base64,QUJD");
  });
});

describe("captureRegionShot", () => {
  it("falls back to a full normalized shot without canvas", async () => {
    const driver = {
      sendCommand: vi.fn(async (_t: unknown, method: string) =>
        method === "Page.captureScreenshot" ? ({ data: "QUJD" } as never) : ({} as never),
      ),
    } as unknown as BrowserDriver;
    const url = await captureRegionShot(driver, 1, { x1: 0, y1: 0, x2: 10, y2: 10 }, 800, 600);
    expect(url.startsWith("data:image/png;base64,")).toBe(true);
  });
});

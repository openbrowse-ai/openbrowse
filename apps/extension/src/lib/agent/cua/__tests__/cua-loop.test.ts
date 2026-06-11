import { describe, expect, it, vi } from "vitest";
import type { BrowserDriver } from "../../driver";
import { cuaToModelOutput, detectNoChange, executeAndShoot, runCuaToolLoop } from "../cua-loop";
import type { CuaRunConfig } from "../provider";

// Controls how the mocked ToolLoopAgent behaves per test.
let mockSteps = 0;
let mockFinalText = "";

// Mock the `ai` module so we can drive `onStepFinish` and the streamed
// UIMessages without a live model. `runCuaToolLoop` constructs
// `new ToolLoopAgent(...)` internally; this lets us exercise its
// truncation → budget-exceeded mapping.
vi.mock("ai", () => {
  class FakeToolLoopAgent {
    private onStepFinish?: () => void;
    constructor(config: { onStepFinish?: () => void }) {
      this.onStepFinish = config.onStepFinish;
    }
    async stream() {
      for (let i = 0; i < mockSteps; i++) this.onStepFinish?.();
      return {
        toUIMessageStream: () => ({}) as never,
      };
    }
  }
  return {
    ToolLoopAgent: FakeToolLoopAgent,
    stepCountIs: (n: number) => n,
    // Yield a single UIMessage carrying mockFinalText (or none if empty).
    readUIMessageStream: () => ({
      async *[Symbol.asyncIterator]() {
        if (mockFinalText) {
          yield { parts: [{ type: "text", text: mockFinalText }] };
        }
      },
    }),
  };
});

function fakeDriver(): BrowserDriver {
  return {
    sendCommand: vi.fn(async (_t: unknown, method: string) => {
      if (method === "Page.captureScreenshot") return { data: "QUJD" } as never; // "ABC"
      return {} as never;
    }),
    sendToContentScript: vi.fn(async () => ({}) as never),
    getTab: vi.fn(async () => ({ id: 1, url: "https://example.com", title: "" })),
    updateTabUrl: vi.fn(async () => {}),
    waitForLoad: vi.fn(async () => {}),
  } as unknown as BrowserDriver;
}

function fakeRunConfig(maxSteps: number): CuaRunConfig {
  const driver = {
    sendCommand: vi.fn(async (_t: unknown, method: string) => {
      if (method === "Page.captureScreenshot") return { data: "QUJD" } as never;
      // readViewport evaluates an expression returning {w,h,dpr}.
      if (method === "Runtime.evaluate") {
        return { result: { value: { w: 800, h: 600, dpr: 1 } } } as never;
      }
      return {} as never;
    }),
    sendToContentScript: vi.fn(async () => ({}) as never),
    getTab: vi.fn(async () => ({ id: 1, url: "https://example.com", title: "" })),
    updateTabUrl: vi.fn(async () => {}),
    waitForLoad: vi.fn(async () => {}),
  } as unknown as BrowserDriver;
  return {
    model: {} as never,
    driver,
    tabId: 1 as never,
    modelId: "claude-sonnet-4-6",
    task: "do a thing",
    systemPrompt: "be helpful",
    maxSteps,
  };
}

function fakeBuild() {
  return () => ({ tools: {} as Record<string, unknown> });
}

describe("executeAndShoot", () => {
  it("runs the action and returns { imageDataUrl, currentUrl } OUTPUT", async () => {
    const driver = fakeDriver();
    // No OffscreenCanvas in this test env → captureNormalizedShot returns the
    // raw capture data URL unchanged.
    const out = await executeAndShoot(
      driver,
      1,
      { kind: "click", x: 5, y: 5 },
      800,
      600,
    );
    expect(out).toEqual({
      imageDataUrl: "data:image/png;base64,QUJD",
      currentUrl: "https://example.com",
    });
  });

  it("fires an in-page click ripple AFTER capturing the screenshot", async () => {
    const order: string[] = [];
    const driver = {
      sendCommand: vi.fn(async (_t: unknown, method: string) => {
        if (method === "Page.captureScreenshot") {
          order.push("capture");
          return { data: "QUJD" } as never;
        }
        return {} as never;
      }),
      sendToContentScript: vi.fn(async (_t: unknown, msg: { type: string }) => {
        order.push(`msg:${msg.type}`);
        return {} as never;
      }),
      getTab: vi.fn(async () => ({ id: 1, url: "https://example.com", title: "" })),
      updateTabUrl: vi.fn(async () => {}),
      waitForLoad: vi.fn(async () => {}),
    } as unknown as BrowserDriver;

    await executeAndShoot(driver, 1, { kind: "click", x: 42, y: 99 }, 800, 600);

    // Passthrough is enabled before the action and disabled after; the
    // screenshot capture happens after the action; and the ripple fires LAST
    // (after capture) so it's never baked into the image sent to the model.
    expect(order).toEqual([
      "msg:CHAT_CUA_INPUT_PASSTHROUGH",
      "msg:CHAT_CUA_INPUT_PASSTHROUGH",
      "capture",
      "msg:CHAT_CUA_CLICK_RIPPLE",
    ]);
    expect(driver.sendToContentScript).toHaveBeenCalledWith(1, {
      type: "CHAT_CUA_CLICK_RIPPLE",
      x: 42,
      y: 99,
    });
  });

  it("toggles shield passthrough on before and off after an input action", async () => {
    const calls: Array<{ type: string; on?: boolean }> = [];
    const driver = {
      sendCommand: vi.fn(async (_t: unknown, method: string) =>
        method === "Page.captureScreenshot"
          ? ({ data: "QUJD" } as never)
          : ({} as never),
      ),
      sendToContentScript: vi.fn(
        async (_t: unknown, msg: { type: string; on?: boolean }) => {
          calls.push(msg);
          return {} as never;
        },
      ),
      getTab: vi.fn(async () => ({ id: 1, url: "https://example.com", title: "" })),
      updateTabUrl: vi.fn(async () => {}),
      waitForLoad: vi.fn(async () => {}),
    } as unknown as BrowserDriver;

    await executeAndShoot(driver, 1, { kind: "click", x: 1, y: 2 }, 800, 600);

    const passthroughs = calls.filter(
      (c) => c.type === "CHAT_CUA_INPUT_PASSTHROUGH",
    );
    expect(passthroughs).toEqual([
      { type: "CHAT_CUA_INPUT_PASSTHROUGH", on: true },
      { type: "CHAT_CUA_INPUT_PASSTHROUGH", on: false },
    ]);
  });

  it("does NOT fire a ripple for non-click actions (e.g. type)", async () => {
    const driver = fakeDriver();
    await executeAndShoot(driver, 1, { kind: "type", text: "hi" }, 800, 600);
    // A `type` action toggles passthrough but never sends a ripple.
    const sent = (driver.sendToContentScript as ReturnType<typeof vi.fn>).mock
      .calls;
    expect(
      sent.some(
        (c: unknown[]) =>
          (c[1] as { type: string }).type === "CHAT_CUA_CLICK_RIPPLE",
      ),
    ).toBe(false);
  });

  it("does not throw if the ripple message fails", async () => {
    const driver = {
      sendCommand: vi.fn(async (_t: unknown, method: string) =>
        method === "Page.captureScreenshot"
          ? ({ data: "QUJD" } as never)
          : ({} as never),
      ),
      sendToContentScript: vi.fn(async () => {
        throw new Error("no content script");
      }),
      getTab: vi.fn(async () => {
        throw new Error("no tab");
      }),
      updateTabUrl: vi.fn(async () => {}),
      waitForLoad: vi.fn(async () => {}),
    } as unknown as BrowserDriver;

    await expect(
      executeAndShoot(driver, 1, { kind: "click", x: 1, y: 2 }, 800, 600),
    ).resolves.toEqual({ imageDataUrl: "data:image/png;base64,QUJD" });
  });
});

describe("runCuaToolLoop — status mapping", () => {
  it("returns budget-exceeded when the step cap is hit with no final text", async () => {
    mockSteps = 3;
    mockFinalText = "";
    const result = await runCuaToolLoop(fakeRunConfig(3), fakeBuild());
    expect(result.status).toBe("budget-exceeded");
  });

  it("returns completed when final text is produced even at the cap", async () => {
    mockSteps = 3;
    mockFinalText = "all done";
    const result = await runCuaToolLoop(fakeRunConfig(3), fakeBuild());
    expect(result.status).toBe("completed");
    expect(result.finalText).toBe("all done");
  });

  it("returns completed when under the step cap", async () => {
    mockSteps = 1;
    mockFinalText = "";
    const result = await runCuaToolLoop(fakeRunConfig(5), fakeBuild());
    expect(result.status).toBe("completed");
  });
});

describe("detectNoChange", () => {
  it("identical shot + state-changing kind → true", () => {
    expect(detectNoChange("X", "X", "click")).toBe(true);
  });
  it("identical shot but non-state-changing kind → false", () => {
    expect(detectNoChange("X", "X", "screenshot")).toBe(false);
  });
  it("different shots → false", () => {
    expect(detectNoChange("X", "Y", "click")).toBe(false);
  });
  it("missing current shot → false", () => {
    expect(detectNoChange("X", undefined, "click")).toBe(false);
  });
});

describe("cuaToModelOutput", () => {
  it("prepends a Current URL text part before the image", () => {
    const out = cuaToModelOutput({
      output: {
        imageDataUrl: "data:image/png;base64,QUJD",
        currentUrl: "https://example.com/x",
      },
    });
    expect(out).toEqual({
      type: "content",
      value: [
        { type: "text", text: "Current URL: https://example.com/x" },
        { type: "image-data", data: "QUJD", mediaType: "image/png" },
      ],
    });
  });

  it("includes a no-change note when noChange is set", () => {
    const out = cuaToModelOutput({
      output: { imageDataUrl: "data:image/png;base64,QUJD", noChange: true },
    }) as { value: Array<{ type: string; text?: string }> };
    expect(out.value[0].type).toBe("text");
    expect(out.value[0].text).toContain("no visible change");
  });

  it("emits image-only content when no URL/noChange present", () => {
    const out = cuaToModelOutput({
      output: { imageDataUrl: "data:image/png;base64,QUJD" },
    });
    expect(out).toEqual({
      type: "content",
      value: [{ type: "image-data", data: "QUJD", mediaType: "image/png" }],
    });
  });

  it("falls back to JSON when no image", () => {
    expect(cuaToModelOutput({ output: { note: "x" } as never })).toEqual({
      type: "json",
      value: { note: "x" },
    });
  });
});

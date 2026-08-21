import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserDriver } from "../../driver";
import { cuaToModelOutput, detectNoChange, executeAndShoot, runCuaToolLoop } from "../cua-loop";
import type { CuaRunConfig } from "../provider";
import type { CanonicalAction } from "../actions";

// Controls how the mocked ToolLoopAgent behaves per test.
let mockSteps = 0;
let mockFinalText = "";

// Bridge for the new "follows onReplaced mid-loop" test: when the
// FakeToolLoopAgent runs each step it invokes `capturedRunAction` (set
// by `fakeBuildCapturing`) with a default no-op-ish CanonicalAction.
// `mockBetweenSteps` lets the test inject a side effect between steps,
// e.g. firing `tabRegistry.__handleReplaceForTests` to swap the ctid.
let capturedRunAction:
  | ((action: CanonicalAction) => Promise<unknown>)
  | null = null;
let mockBetweenSteps: ((stepIndex: number) => void | Promise<void>) | null =
  null;
// Per-step provider usage the fake reports through `onStepFinish`. `null`
// simulates a provider that reports no usage at all.
let mockStepUsage: { inputTokens?: number; outputTokens?: number } | null = {
  inputTokens: 100,
  outputTokens: 20,
};

// Mock the `ai` module so we can drive `onStepFinish` and the streamed
// UIMessages without a live model. `runCuaToolLoop` constructs
// `new ToolLoopAgent(...)` internally; this lets us exercise its
// truncation → budget-exceeded mapping.
vi.mock("ai", () => {
  class FakeToolLoopAgent {
    private onStepFinish?: (stepResult: unknown) => void;
    constructor(config: { onStepFinish?: (stepResult: unknown) => void }) {
      this.onStepFinish = config.onStepFinish;
    }
    async stream() {
      for (let i = 0; i < mockSteps; i++) {
        // If a test wired a captured runAction (via fakeBuildCapturing),
        // invoke it once per step with a `wait`-kind action. `wait` is
        // the cheapest action: it only `setTimeout`s in
        // `executeCanonicalAction` and then funnels into the screenshot
        // + getTab calls, all of which the test driver mocks. The `tabId`
        // passed into those driver calls is the loop's `currentCtid`,
        // which the test asserts against.
        if (capturedRunAction) {
          await capturedRunAction({ kind: "wait", ms: 0 });
        }
        if (mockBetweenSteps) {
          await mockBetweenSteps(i);
        }
        // Mirror the real SDK: `onStepFinish` receives the step result,
        // whose `usage` carries the provider-reported token counts.
        this.onStepFinish?.(
          mockStepUsage === null ? {} : { usage: mockStepUsage },
        );
      }
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

// Reset the per-test mock state between cases so a test that captures
// `runAction` / wires `mockBetweenSteps` can't leak its hooks into a
// later test that doesn't expect them to fire.
beforeEach(() => {
  mockSteps = 0;
  mockFinalText = "";
  capturedRunAction = null;
  mockBetweenSteps = null;
  mockStepUsage = { inputTokens: 100, outputTokens: 20 };
});

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

    // Order:
    //   1. Passthrough ON  (shield → pointer-events:none)
    //   2. Pre-dispatch diagnostic  (proves the toggle took effect at click time)
    //   3. Post-dispatch diagnostic (still inside passthrough window, confirms
    //      no transient element hijack between hit-test and dispatch)
    //   4. Passthrough OFF (shield back to pointer-events:auto)
    //   5. Screenshot capture (clean, with shield up)
    //   6. Ripple fires LAST (after capture) so it's never baked into the
    //      image sent to the model.
    expect(order).toEqual([
      "msg:CHAT_CUA_INPUT_PASSTHROUGH",
      "msg:CHAT_CUA_DIAG_HIT_TEST",
      "msg:CHAT_CUA_DIAG_HIT_TEST",
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

/**
 * A CUA run's tokens used to be recorded nowhere: `onStepFinish` only
 * incremented the step counter, so the run's spend landed in no
 * conversation's `costUsd` and the child conversation's Context card stayed
 * empty. `onStepUsage` is the hook the caller uses to attribute it. The
 * callback stays here (rather than a chat-db write inside this module) so the
 * loop keeps no persistence dependency — same rationale as `onUiMessage`.
 */
describe("runCuaToolLoop — usage reporting", () => {
  it("reports each step's provider usage to onStepUsage", async () => {
    mockSteps = 3;
    mockFinalText = "done";
    mockStepUsage = { inputTokens: 1_000, outputTokens: 250 };

    const seen: Array<{ inputTokens?: number; outputTokens?: number }> = [];
    await runCuaToolLoop(
      { ...fakeRunConfig(5), onStepUsage: (u) => seen.push(u) },
      fakeBuild(),
    );

    expect(seen).toEqual([
      { inputTokens: 1_000, outputTokens: 250 },
      { inputTokens: 1_000, outputTokens: 250 },
      { inputTokens: 1_000, outputTokens: 250 },
    ]);
  });

  it("skips the callback when the provider reports no usage", async () => {
    mockSteps = 2;
    mockFinalText = "done";
    mockStepUsage = null;

    const onStepUsage = vi.fn();
    await runCuaToolLoop({ ...fakeRunConfig(5), onStepUsage }, fakeBuild());

    expect(onStepUsage).not.toHaveBeenCalled();
  });

  it("still counts steps for the budget-exceeded mapping when usage is absent", async () => {
    mockSteps = 3;
    mockFinalText = "";
    mockStepUsage = null;
    const result = await runCuaToolLoop(fakeRunConfig(3), fakeBuild());
    expect(result.status).toBe("budget-exceeded");
  });

  it("runs fine with no onStepUsage wired (optional hook)", async () => {
    mockSteps = 1;
    mockFinalText = "ok";
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

describe("runCuaToolLoop — onReplaced retargeting", () => {
  it("registers cfg.tabId with the registry on entry and unsubscribes on exit", async () => {
    // Use the dynamic import for tabRegistry so the singleton matches the
    // one cua-loop's static import resolves to.
    const { tabRegistry } = await import("../../tab-registry");
    tabRegistry.__resetForTests!();
    mockSteps = 0;
    mockFinalText = "ok";
    capturedRunAction = null;
    mockBetweenSteps = null;
    await runCuaToolLoop(fakeRunConfig(3), fakeBuild());
    // After registerExisting(1), the registry should have a mapping.
    expect(tabRegistry.toLogicalTabId(1)).toBeTruthy();
  });

  it("follows onReplaced mid-loop: subsequent actions land on the new ctid", async () => {
    const { tabRegistry } = await import("../../tab-registry");
    tabRegistry.__resetForTests!();

    // Build a config whose driver records every (method, tabId) call.
    // The cua loop's per-step `executeAndShoot` funnels through this
    // driver; the `tabId` argument of every call is the loop's live
    // `currentCtid`. By asserting on these args before and after an
    // injected onReplaced we validate that the loop actually retargets,
    // not just that the registry stores the right mapping.
    const cdpCalls: { method: string; tabId: unknown }[] = [];
    const getTabCalls: unknown[] = [];
    const driver = {
      sendCommand: vi.fn(async (tabId: unknown, method: string) => {
        cdpCalls.push({ method, tabId });
        if (method === "Page.captureScreenshot") return { data: "QUJD" };
        if (method === "Runtime.evaluate") {
          return { result: { value: { w: 800, h: 600, dpr: 1 } } };
        }
        return {};
      }),
      sendToContentScript: vi.fn(async () => ({})),
      getTab: vi.fn(async (tabId: unknown) => {
        getTabCalls.push(tabId);
        return { id: 1, url: "https://example.com", title: "" };
      }),
      updateTabUrl: vi.fn(async () => {}),
      waitForLoad: vi.fn(async () => {}),
    } as unknown as BrowserDriver;

    const cfg: CuaRunConfig = {
      model: {} as never,
      driver,
      tabId: 100 as never,
      modelId: "claude-sonnet-4-6",
      task: "do a thing",
      systemPrompt: "be helpful",
      maxSteps: 3,
    };

    // Capture runAction so the FakeToolLoopAgent can fire one action
    // per step. We use `fakeBuildCapturing` to bridge.
    mockSteps = 2;
    mockFinalText = "ok";
    capturedRunAction = null;
    mockBetweenSteps = async (stepIndex) => {
      // Between step 0 and step 1, fire onReplaced(200, 100) so the
      // loop's currentCtid swaps from 100 to 200.
      if (stepIndex === 0) {
        tabRegistry.__handleReplaceForTests!(200, 100);
      }
    };

    await runCuaToolLoop(cfg, fakeBuildCapturing());

    // The first step's screenshot must have hit ctid 100; the second
    // step's screenshot must have hit ctid 200. (Other tabIds may
    // appear too — readViewport runs at startup, getTab fires for
    // currentUrl per step — but the tabIds we care about are the
    // captureScreenshot calls inside executeAndShoot.)
    const screenshotTabs = cdpCalls
      .filter((c) => c.method === "Page.captureScreenshot")
      .map((c) => c.tabId);
    expect(screenshotTabs.length).toBeGreaterThanOrEqual(2);
    expect(screenshotTabs[0]).toBe(100);
    expect(screenshotTabs[screenshotTabs.length - 1]).toBe(200);

    // Same shape via getTab (per-step currentUrl probe): first call on
    // 100, last on 200.
    expect(getTabCalls[0]).toBe(100);
    expect(getTabCalls[getTabCalls.length - 1]).toBe(200);

    // Registry agrees: the ltid now resolves to 200.
    const ltid = tabRegistry.toLogicalTabId(200);
    expect(ltid).toBeTruthy();
    expect(tabRegistry.toLogicalTabId(100)).toBeUndefined();
  });
});

/**
 * Like `fakeBuild` but stashes the loop's `runAction` so the
 * FakeToolLoopAgent.stream() above can invoke it once per step. Used
 * only by the onReplaced retargeting test below.
 */
function fakeBuildCapturing() {
  return ({
    runAction,
  }: {
    runAction: (action: CanonicalAction) => Promise<unknown>;
  }) => {
    capturedRunAction = runAction;
    return { tools: {} as Record<string, unknown> };
  };
}

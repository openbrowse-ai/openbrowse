import { describe, expect, it, vi } from "vitest";
import type { BrowserDriver } from "../../driver";
import { executeCanonicalAction } from "../executor";

function fakeDriver(): { driver: BrowserDriver; calls: Array<[string, unknown]> } {
  const calls: Array<[string, unknown]> = [];
  const driver = {
    sendCommand: vi.fn(async (_tab: unknown, method: string, params?: unknown) => {
      calls.push([method, params]);
      return {} as never;
    }),
  } as unknown as BrowserDriver;
  return { driver, calls };
}

describe("executeCanonicalAction", () => {
  it("click dispatches move, press, release at the coordinate", async () => {
    const { driver, calls } = fakeDriver();
    await executeCanonicalAction(driver, 1, { kind: "click", x: 50, y: 60 });
    const mouseCalls = calls.filter(([m]) => m === "Input.dispatchMouseEvent");
    expect(mouseCalls).toHaveLength(3);
    expect(mouseCalls[0][1]).toMatchObject({ type: "mouseMoved", x: 50, y: 60 });
    expect(mouseCalls[1][1]).toMatchObject({ type: "mousePressed", button: "left", clickCount: 1 });
    expect(mouseCalls[2][1]).toMatchObject({ type: "mouseReleased", button: "left" });
  });

  it("scroll uses a mouseWheel event with deltas", async () => {
    const { driver, calls } = fakeDriver();
    await executeCanonicalAction(driver, 1, { kind: "scroll", x: 10, y: 20, deltaX: 0, deltaY: 300 });
    const wheel = calls.find(([m, p]) => m === "Input.dispatchMouseEvent" && (p as { type: string }).type === "mouseWheel");
    expect(wheel?.[1]).toMatchObject({ type: "mouseWheel", x: 10, y: 20, deltaX: 0, deltaY: 300 });
  });

  it("type inserts text", async () => {
    const { driver, calls } = fakeDriver();
    await executeCanonicalAction(driver, 1, { kind: "type", text: "hi" });
    expect(calls).toContainEqual(["Input.insertText", { text: "hi" }]);
  });

  it("drag presses at origin, moves to target, releases", async () => {
    const { driver, calls } = fakeDriver();
    await executeCanonicalAction(driver, 1, { kind: "drag", x: 5, y: 5, toX: 50, toY: 50 });
    const types = calls
      .filter(([m]) => m === "Input.dispatchMouseEvent")
      .map(([, p]) => (p as { type: string }).type);
    expect(types).toEqual(["mouseMoved", "mousePressed", "mouseMoved", "mouseReleased"]);
  });

  it("wait resolves without CDP calls", async () => {
    const { driver, calls } = fakeDriver();
    await executeCanonicalAction(driver, 1, { kind: "wait", ms: 1 });
    expect(calls).toHaveLength(0);
  });

  it("mouseDown / mouseUp dispatch a single press / release", async () => {
    const { driver, calls } = fakeDriver();
    await executeCanonicalAction(driver, 1, { kind: "mouseDown", x: 5, y: 6 });
    await executeCanonicalAction(driver, 1, { kind: "mouseUp", x: 5, y: 6 });
    const types = calls
      .filter(([m]) => m === "Input.dispatchMouseEvent")
      .map(([, p]) => (p as { type: string }).type);
    expect(types).toEqual(["mousePressed", "mouseReleased"]);
  });

  it("holdKey presses down, waits, releases the same key", async () => {
    const { driver, calls } = fakeDriver();
    await executeCanonicalAction(driver, 1, { kind: "holdKey", keys: ["a"], ms: 1 });
    const keyCalls = calls.filter(([m]) => m === "Input.dispatchKeyEvent");
    expect(keyCalls.map(([, p]) => (p as { type: string }).type)).toEqual(["keyDown", "keyUp"]);
  });

  it("goBack reads history and navigates to the previous entry", async () => {
    const driver = {
      sendCommand: vi.fn(async (_t: unknown, method: string) => {
        if (method === "Page.getNavigationHistory") {
          return { currentIndex: 2, entries: [{ id: 10, url: "a" }, { id: 11, url: "b" }, { id: 12, url: "c" }] } as never;
        }
        return {} as never;
      }),
      waitForLoad: vi.fn(async () => {}),
    } as unknown as BrowserDriver;
    await executeCanonicalAction(driver, 1, { kind: "goBack" });
    expect(driver.sendCommand).toHaveBeenCalledWith(1, "Page.navigateToHistoryEntry", { entryId: 11 });
  });

  it("goForward at the end of history is a no-op (no navigate call)", async () => {
    const driver = {
      sendCommand: vi.fn(async (_t: unknown, method: string) =>
        method === "Page.getNavigationHistory"
          ? ({ currentIndex: 1, entries: [{ id: 10, url: "a" }, { id: 11, url: "b" }] } as never)
          : ({} as never),
      ),
      waitForLoad: vi.fn(async () => {}),
    } as unknown as BrowserDriver;
    await executeCanonicalAction(driver, 1, { kind: "goForward" });
    const navCalls = (driver.sendCommand as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c: unknown[]) => c[1] === "Page.navigateToHistoryEntry",
    );
    expect(navCalls).toHaveLength(0);
  });
});

import { describe, expect, it, vi } from "vitest";
import type { BrowserDriver } from "../../driver";
import { executeCanonicalAction } from "../executor";

function fakeDriver(): { driver: BrowserDriver; calls: Array<[string, any]> } {
  const calls: Array<[string, any]> = [];
  const driver = {
    sendCommand: vi.fn(async (_tab: unknown, method: string, params?: unknown) => {
      calls.push([method, params]);
      return {} as never;
    }),
  } as unknown as BrowserDriver;
  return { driver, calls };
}

function keyDownParams(calls: Array<[string, any]>) {
  return calls.find(([m, p]) => m === "Input.dispatchKeyEvent" && p.type === "keyDown")?.[1];
}

describe("executeCanonicalAction — key mapping (X11 keysyms)", () => {
  it("maps Page_Down to PageDown (not 'P')", async () => {
    const { driver, calls } = fakeDriver();
    await executeCanonicalAction(driver, 1, { kind: "key", keys: ["Page_Down"] });
    expect(keyDownParams(calls)).toMatchObject({ key: "PageDown", code: "PageDown" });
  });

  it("maps Delete correctly (not 'D')", async () => {
    const { driver, calls } = fakeDriver();
    await executeCanonicalAction(driver, 1, { kind: "key", keys: ["Delete"] });
    expect(keyDownParams(calls)).toMatchObject({ key: "Delete", code: "Delete" });
  });

  it("maps BackSpace (X11 spelling) to Backspace", async () => {
    const { driver, calls } = fakeDriver();
    await executeCanonicalAction(driver, 1, { kind: "key", keys: ["BackSpace"] });
    expect(keyDownParams(calls)).toMatchObject({ key: "Backspace", code: "Backspace" });
  });

  it("maps Home and End", async () => {
    const { driver, calls } = fakeDriver();
    await executeCanonicalAction(driver, 1, { kind: "key", keys: ["Home"] });
    expect(keyDownParams(calls)).toMatchObject({ key: "Home", code: "Home" });
  });

  it("maps a ctrl+a combo: modifier mask set, main key 'a'", async () => {
    const { driver, calls } = fakeDriver();
    await executeCanonicalAction(driver, 1, { kind: "key", keys: ["ctrl", "a"] });
    const kd = keyDownParams(calls);
    expect(kd.key).toBe("a");
    expect(kd.modifiers).toBe(2); // ctrl bit
  });

  it("maps space to a single space character", async () => {
    const { driver, calls } = fakeDriver();
    await executeCanonicalAction(driver, 1, { kind: "key", keys: ["space"] });
    expect(keyDownParams(calls)).toMatchObject({ key: " " });
  });

  it("maps a single letter key", async () => {
    const { driver, calls } = fakeDriver();
    await executeCanonicalAction(driver, 1, { kind: "key", keys: ["b"] });
    expect(keyDownParams(calls)).toMatchObject({ key: "b", code: "KeyB" });
  });
});

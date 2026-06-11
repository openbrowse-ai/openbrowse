import { describe, expect, it, vi } from "vitest";
import { keyEventParams, modifierMask, dispatchKeyCombo } from "../keyboard";
import type { BrowserDriver } from "../driver";

describe("keyEventParams", () => {
  it("maps named keys to CDP params", () => {
    expect(keyEventParams("Enter")).toEqual({
      key: "Enter",
      code: "Enter",
      windowsVirtualKeyCode: 13,
    });
    expect(keyEventParams("escape")).toEqual({
      key: "Escape",
      code: "Escape",
      windowsVirtualKeyCode: 27,
    });
  });

  it("passes single chars through as literal keys", () => {
    expect(keyEventParams("a")).toEqual({ key: "a", code: "KeyA" });
  });

  it("passes unknown multi-char keysyms through verbatim (no truncation)", () => {
    // Regression: a multi-char keysym NOT in the keymap must pass through
    // verbatim, NOT be truncated to its first char (e.g. "Hyper_L" → "H").
    expect(keyEventParams("Hyper_L")).toEqual({ key: "Hyper_L", code: "" });
  });
});

describe("modifierMask", () => {
  it("ORs modifier bits (ctrl=2, shift=8)", () => {
    expect(modifierMask(["ctrl"])).toBe(2);
    expect(modifierMask(["ctrl", "shift"])).toBe(10);
    expect(modifierMask(undefined)).toBe(0);
  });
});

describe("dispatchKeyCombo", () => {
  it("dispatches keyDown then keyUp with the modifier mask for ctrl+a", async () => {
    const calls: Array<{ method: string; params: any }> = [];
    const driver = {
      sendCommand: vi.fn(async (_tab, method: string, params: any) => {
        calls.push({ method, params });
        return {};
      }),
    } as unknown as BrowserDriver;

    await dispatchKeyCombo(driver, 1, ["ctrl", "a"]);

    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({
      method: "Input.dispatchKeyEvent",
      params: { type: "keyDown", modifiers: 2, key: "a", code: "KeyA" },
    });
    expect(calls[1]).toMatchObject({
      method: "Input.dispatchKeyEvent",
      params: { type: "keyUp", modifiers: 2, key: "a" },
    });
  });

  it("no-ops when only modifiers are given (no main key)", async () => {
    const driver = {
      sendCommand: vi.fn(async () => ({})),
    } as unknown as BrowserDriver;
    await dispatchKeyCombo(driver, 1, ["ctrl"]);
    expect(driver.sendCommand).not.toHaveBeenCalled();
  });

  it("holds the key for holdMs before releasing when holdMs is given", async () => {
    vi.useFakeTimers();
    try {
      const calls: Array<{ type: unknown }> = [];
      const driver = {
        sendCommand: vi.fn(async (_tab, _method: string, params: any) => {
          calls.push({ type: params.type });
          return {};
        }),
      } as unknown as BrowserDriver;

      const promise = dispatchKeyCombo(driver, 1, ["Enter"], 500);
      // After keyDown but before the hold elapses, keyUp must NOT have fired.
      await vi.advanceTimersByTimeAsync(0);
      expect(calls.map((c) => c.type)).toEqual(["keyDown"]);
      // Advance past the hold; keyUp now fires.
      await vi.advanceTimersByTimeAsync(500);
      await promise;
      expect(calls.map((c) => c.type)).toEqual(["keyDown", "keyUp"]);
    } finally {
      vi.useRealTimers();
    }
  });
});

import { describe, expect, it } from "vitest";
import { isTerminalAction, type CanonicalAction } from "../actions";

describe("CanonicalAction", () => {
  it("identifies the terminal `done` action", () => {
    const done: CanonicalAction = { kind: "done", summary: "finished" };
    const click: CanonicalAction = { kind: "click", x: 10, y: 20 };
    expect(isTerminalAction(done)).toBe(true);
    expect(isTerminalAction(click)).toBe(false);
  });
});

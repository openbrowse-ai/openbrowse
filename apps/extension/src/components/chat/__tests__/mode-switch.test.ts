import { describe, expect, it } from "vitest";
import { MODE_OPTIONS, nextMode, shortLabel } from "../ModeSwitch";

/**
 * The full ModeSwitch component is JSX + click handlers; the project
 * doesn't pull in @testing-library/react, so we test the extractable
 * pieces (the options table and the short-label helper) instead.
 */
describe("ModeSwitch — MODE_OPTIONS", () => {
  it("has three modes in ask/plan/act order (load-bearing for the cycle helper)", () => {
    expect(MODE_OPTIONS.map((o) => o.value)).toEqual(["ask", "plan", "act"]);
  });

  it("each option has a non-empty label and description", () => {
    for (const opt of MODE_OPTIONS) {
      expect(opt.label.length).toBeGreaterThan(0);
      expect(opt.description.length).toBeGreaterThan(0);
    }
  });

  it("ask is the first (default) option", () => {
    expect(MODE_OPTIONS[0].value).toBe("ask");
  });
});

describe("ModeSwitch — shortLabel", () => {
  it("returns short labels for each mode", () => {
    expect(shortLabel("ask")).toBe("Ask");
    expect(shortLabel("plan")).toBe("Plan");
    expect(shortLabel("act")).toBe("Act");
  });
});

describe("ModeSwitch — nextMode (cycle for Cmd+. hotkey)", () => {
  it("cycles ask → plan → act → ask", () => {
    expect(nextMode("ask")).toBe("plan");
    expect(nextMode("plan")).toBe("act");
    expect(nextMode("act")).toBe("ask");
  });
});

import { describe, expect, it } from "vitest";
import { computerLabels } from "../ToolCallBlock";

const fallback = { pending: "Using computer...", done: "Used computer" };

describe("computerLabels", () => {
  it("describes a left click with coordinates", () => {
    expect(
      computerLabels({ action: "left_click", coordinate: [100, 200] }, fallback),
    ).toEqual({ pending: "Clicking at (100, 200)...", done: "Clicked at (100, 200)" });
  });

  it("describes a screenshot", () => {
    expect(computerLabels({ action: "screenshot" }, fallback)).toEqual({
      pending: "Taking screenshot...",
      done: "Took screenshot",
    });
  });

  it("describes typing with a truncated preview", () => {
    expect(computerLabels({ action: "type", text: "hello" }, fallback)).toEqual({
      pending: 'Typing "hello"...',
      done: 'Typed "hello"',
    });
    const long = "x".repeat(40);
    const out = computerLabels({ action: "type", text: long }, fallback);
    expect(out.done).toContain("…");
  });

  it("describes a key press", () => {
    expect(computerLabels({ action: "key", text: "ctrl+a" }, fallback)).toEqual({
      pending: "Pressing ctrl+a...",
      done: "Pressed ctrl+a",
    });
  });

  it("describes a scroll with direction", () => {
    expect(
      computerLabels(
        { action: "scroll", coordinate: [5, 5], scroll_direction: "down" },
        fallback,
      ),
    ).toEqual({ pending: "Scrolling down...", done: "Scrolled down" });
  });

  it("describes double/right clicks", () => {
    expect(computerLabels({ action: "double_click", coordinate: [1, 2] }, fallback).done).toBe(
      "Double-clicked at (1, 2)",
    );
    expect(computerLabels({ action: "right_click", coordinate: [1, 2] }, fallback).done).toBe(
      "Right-clicked at (1, 2)",
    );
  });

  it("falls back for an unknown/missing action", () => {
    expect(computerLabels({}, fallback)).toEqual(fallback);
    expect(computerLabels({ action: "unknown_thing" }, fallback)).toEqual(fallback);
  });
});

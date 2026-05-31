import { describe, expect, it } from "vitest";
import { closeTabsLabels } from "../ToolCallBlock";

const fallback = { pending: "Closing tabs...", done: "Closed tabs" };

describe("closeTabsLabels", () => {
  it("describes a group close", () => {
    expect(closeTabsLabels({ target: "group" }, fallback)).toEqual({
      pending: "Closing tab group...",
      done: "Closed tab group",
    });
  });

  it("pluralizes a multi-tab close", () => {
    expect(
      closeTabsLabels({ target: "tabs", handles: ["t1", "t2"] }, fallback),
    ).toEqual({ pending: "Closing 2 tabs...", done: "Closed 2 tabs" });
  });

  it("singularizes a one-tab close", () => {
    expect(
      closeTabsLabels({ target: "tabs", handles: ["t1"] }, fallback),
    ).toEqual({ pending: "Closing 1 tab...", done: "Closed 1 tab" });
  });

  it("falls back when target:'tabs' has no handles", () => {
    expect(closeTabsLabels({ target: "tabs" }, fallback)).toBe(fallback);
    expect(closeTabsLabels({ target: "tabs", handles: [] }, fallback)).toBe(
      fallback,
    );
  });

  it("falls back on unknown/missing args", () => {
    expect(closeTabsLabels({}, fallback)).toBe(fallback);
  });
});

import { describe, expect, it } from "vitest";
import { formatCloseTabsPreview } from "../tool-previews/close-tabs";

describe("formatCloseTabsPreview", () => {
  it("describes a group close", () => {
    expect(formatCloseTabsPreview({ target: "group" }, 7)).toBe(
      "Close 7 tabs in this conversation's group",
    );
  });
  it("singularizes one tab", () => {
    expect(formatCloseTabsPreview({ target: "group" }, 1)).toBe(
      "Close 1 tab in this conversation's group",
    );
  });
  it("describes a specific-tabs close", () => {
    expect(
      formatCloseTabsPreview({ target: "tabs", handles: ["t1", "t2"] }, 2),
    ).toBe("Close 2 tabs");
  });
  it("singularizes a one-tab close", () => {
    expect(
      formatCloseTabsPreview({ target: "tabs", handles: ["t1"] }, 1),
    ).toBe("Close 1 tab");
  });
});

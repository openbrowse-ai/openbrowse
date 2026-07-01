import { describe, expect, it } from "vitest";
import { formatActionLabel, formatOutcomeLabel } from "../action-labels";

describe("action-labels — formatActionLabel", () => {
  it("maps known RPC methods to friendly verbs", () => {
    expect(formatActionLabel("task")).toBe("Ran a task");
    expect(formatActionLabel("cancel_task")).toBe("Cancelled a task");
    expect(formatActionLabel("read_page")).toBe("Read a page");
    expect(formatActionLabel("screenshot")).toBe("Took a screenshot");
    expect(formatActionLabel("open_url")).toBe("Opened a URL");
    expect(formatActionLabel("get_context")).toBe("Asked about your browser");
    expect(formatActionLabel("list_windows")).toBe("Listed your windows");
    expect(formatActionLabel("list_spaces")).toBe("Listed your spaces");
  });

  it("passes unknown methods through verbatim", () => {
    expect(formatActionLabel("future_method")).toBe("future_method");
    expect(formatActionLabel("")).toBe("");
  });
});

describe("action-labels — formatOutcomeLabel", () => {
  it("renders Success for ok", () => {
    expect(formatOutcomeLabel("ok")).toBe("Success");
  });
  it("renders Error for error", () => {
    expect(formatOutcomeLabel("error")).toBe("Error");
  });
  it("renders Denied for denied", () => {
    expect(formatOutcomeLabel("denied")).toBe("Denied");
  });
  it("renders Rate limited for rate_limited", () => {
    expect(formatOutcomeLabel("rate_limited")).toBe("Rate limited");
  });
});

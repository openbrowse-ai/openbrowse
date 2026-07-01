import { describe, expect, it } from "vitest";
import {
  buildCancelMessage,
  canOpenConversation,
  formatElapsed,
  pickDisplayTitle,
  pickProgressLine,
  type ActiveTaskSummary,
} from "../ActiveTaskCard";

describe("ActiveTaskCard — buildCancelMessage", () => {
  it("builds the cancel-task message shape", () => {
    expect(buildCancelMessage("t1")).toEqual({
      type: "MCP_BRIDGE_CANCEL_TASK",
      taskId: "t1",
    });
  });
});

describe("ActiveTaskCard — formatElapsed", () => {
  it("renders seconds while under a minute", () => {
    expect(formatElapsed(0, 5_000)).toBe("5s");
    expect(formatElapsed(0, 59_000)).toBe("59s");
  });

  it("rolls over to minutes at 60s", () => {
    expect(formatElapsed(0, 60_000)).toBe("1m");
    expect(formatElapsed(0, 90_000)).toBe("1m");
    expect(formatElapsed(0, 59 * 60_000)).toBe("59m");
  });

  it("rolls over to hours at 3600s", () => {
    expect(formatElapsed(0, 60 * 60_000)).toBe("1h");
    expect(formatElapsed(0, 125 * 60_000)).toBe("2h");
  });

  it("clamps negative durations to 0s (defensive against clock skew)", () => {
    expect(formatElapsed(10_000, 5_000)).toBe("0s");
  });
});

describe("ActiveTaskCard — pickDisplayTitle", () => {
  const base: ActiveTaskSummary = {
    taskId: "t",
    hostName: "h",
    prompt: "raw prompt",
    conversationId: null,
    targetWindowId: 0,
    spaceId: null,
    startedAt: 0,
    taskTitlePreview: null,
    currentUrl: null,
    lastEvent: null,
  };

  it("prefers the title preview when present", () => {
    expect(pickDisplayTitle({ ...base, taskTitlePreview: "Nice Title" })).toBe(
      "Nice Title",
    );
  });

  it("falls back to the raw prompt when no preview", () => {
    expect(pickDisplayTitle(base)).toBe("raw prompt");
  });
});

describe("ActiveTaskCard — pickProgressLine", () => {
  it("returns both url and event when both are present (stacked render)", () => {
    expect(
      pickProgressLine({
        currentUrl: "https://example.com/page",
        lastEvent: "click on Companies",
      }),
    ).toEqual({
      url: "https://example.com/page",
      event: "click on Companies",
    });
  });

  it("returns url only when only currentUrl is present", () => {
    expect(
      pickProgressLine({ currentUrl: "https://example.com", lastEvent: null }),
    ).toEqual({ url: "https://example.com", event: null });
  });

  it("returns event only when only lastEvent is present", () => {
    expect(
      pickProgressLine({ currentUrl: null, lastEvent: "navigating to home" }),
    ).toEqual({ url: null, event: "navigating to home" });
  });

  it("returns both nulls when nothing is known yet", () => {
    expect(pickProgressLine({ currentUrl: null, lastEvent: null })).toEqual({
      url: null,
      event: null,
    });
  });

  it("treats empty strings as null (defensive against placeholder values)", () => {
    expect(pickProgressLine({ currentUrl: "", lastEvent: "" })).toEqual({
      url: null,
      event: null,
    });
  });
});

describe("ActiveTaskCard — canOpenConversation", () => {
  it("returns true for a real conversation id", () => {
    expect(canOpenConversation("conv-abc")).toBe(true);
  });

  it("returns false for null (the not-yet-available marker, B18)", () => {
    expect(canOpenConversation(null)).toBe(false);
  });

  it("returns false for the empty string (legacy sentinel)", () => {
    expect(canOpenConversation("")).toBe(false);
  });

  it("returns false for whitespace-only ids (defensive)", () => {
    expect(canOpenConversation("   ")).toBe(false);
  });
});

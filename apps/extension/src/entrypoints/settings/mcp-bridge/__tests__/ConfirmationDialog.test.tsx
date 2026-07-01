import { describe, expect, it } from "vitest";
import {
  buildAlwaysAllowMessages,
  buildConfirmMessage,
  formatAutoDenyCaption,
  formatTargetCaption,
} from "../ConfirmationDialog";

/**
 * Pure-helper tests. The full component is JSX + click handlers; the
 * project tests behavior by extracting message builders and
 * formatters (established pattern, see `mode-switch.test.ts`).
 */
describe("ConfirmationDialog — buildConfirmMessage", () => {
  it("builds an allow message for the given promptId", () => {
    expect(buildConfirmMessage("p1", "allow")).toEqual({
      type: "MCP_BRIDGE_CONFIRM_TASK",
      promptId: "p1",
      outcome: "allow",
    });
  });

  it("builds a deny message for the given promptId", () => {
    expect(buildConfirmMessage("p2", "deny")).toEqual({
      type: "MCP_BRIDGE_CONFIRM_TASK",
      promptId: "p2",
      outcome: "deny",
    });
  });
});

describe("ConfirmationDialog — buildAlwaysAllowMessages", () => {
  it("builds a SET_POLICY + CONFIRM_TASK pair targeting auto-allow + allow", () => {
    expect(buildAlwaysAllowMessages("c1", "p1")).toEqual({
      setPolicy: {
        type: "MCP_BRIDGE_SET_POLICY",
        clientId: "c1",
        policy: "auto-allow",
      },
      confirm: {
        type: "MCP_BRIDGE_CONFIRM_TASK",
        promptId: "p1",
        outcome: "allow",
      },
    });
  });
});

describe("ConfirmationDialog — formatTargetCaption", () => {
  it("falls back to 'In a browser window' when neither space nor URL is known", () => {
    // The historical caption surfaced the raw chrome windowId (a
    // meaningless integer for users). Post-overhaul we treat the
    // windowId as opaque and surface only fields the user can act on.
    expect(formatTargetCaption({ windowId: 100 })).toBe(
      "In a browser window",
    );
  });

  it("renders the space name when present", () => {
    expect(
      formatTargetCaption({ windowId: 100, spaceName: "Work" }),
    ).toBe("In your Work space");
  });

  it("appends the active URL when only the URL is known", () => {
    expect(
      formatTargetCaption({
        windowId: 100,
        activeTabUrl: "https://example.com",
      }),
    ).toBe("In a browser window · https://example.com");
  });

  it("combines space + URL with a separator", () => {
    expect(
      formatTargetCaption({
        windowId: 100,
        spaceName: "Work",
        activeTabUrl: "https://example.com",
      }),
    ).toBe("In your Work space · https://example.com");
  });
});

describe("ConfirmationDialog — formatAutoDenyCaption", () => {
  const NOW = 1_700_000_000_000;

  it("formats seconds remaining with a friendly verb", () => {
    expect(formatAutoDenyCaption(NOW + 47_000, NOW)).toBe("Auto-cancels in 47s");
  });

  it("rounds up partial seconds to avoid '0s' jitter", () => {
    expect(formatAutoDenyCaption(NOW + 500, NOW)).toBe("Auto-cancels in 1s");
  });

  it("returns null when deadline is null (user picked 'Never')", () => {
    expect(formatAutoDenyCaption(null, NOW)).toBeNull();
  });

  it("returns null when deadline is undefined (legacy callers)", () => {
    expect(formatAutoDenyCaption(undefined, NOW)).toBeNull();
  });

  it("returns null when deadline has already passed", () => {
    expect(formatAutoDenyCaption(NOW - 1, NOW)).toBeNull();
  });
});

import { describe, expect, it } from "vitest";
import { badgeUpdateFor } from "../badge";
import type { BridgeStatus } from "../status";

/**
 * Helper: build the three-input args object with sensible defaults.
 * Status defaults to `connected` so individual cases can vary only the
 * field they care about.
 */
function args(overrides: {
  status?: BridgeStatus;
  pendingPromptCount?: number;
  activeTaskCount?: number;
} = {}) {
  return {
    status: overrides.status ?? {
      kind: "connected" as const,
      brokerVersion: "v",
      sessionId: "s",
      connectedAt: 0,
    },
    pendingPromptCount: overrides.pendingPromptCount ?? 0,
    activeTaskCount: overrides.activeTaskCount ?? 0,
  };
}

describe("mcp-bridge/badge — badgeUpdateFor", () => {
  describe("connection alerts beat MCP activity", () => {
    it("renders amber '!' for awaiting_tofu (even with prompts + tasks pending)", () => {
      const update = badgeUpdateFor(
        args({
          status: {
            kind: "awaiting_tofu",
            prompt: {
              fingerprint: "fp",
              processInfo: { pid: 1, executablePath: "/x", startedAt: 0 },
              nonce: "n",
            },
          },
          pendingPromptCount: 3,
          activeTaskCount: 2,
        }),
      );
      expect(update.text).toBe("!");
      expect(update.color).toBe("#f59e0b");
      expect(update.title).toMatch(/awaiting your trust/);
    });

    it("renders red '!' for key_mismatch (even with prompts + tasks pending)", () => {
      const update = badgeUpdateFor(
        args({
          status: {
            kind: "key_mismatch",
            storedFingerprint: "old",
            presentedFingerprint: "new",
          },
          pendingPromptCount: 1,
          activeTaskCount: 1,
        }),
      );
      expect(update.text).toBe("!");
      expect(update.color).toBe("#ef4444");
      expect(update.title).toMatch(/key changed/);
    });
  });

  describe("MCP activity (no connection alert)", () => {
    it("renders blue '<count>' when pending prompts > 0", () => {
      const update = badgeUpdateFor(args({ pendingPromptCount: 2 }));
      expect(update.text).toBe("2");
      expect(update.color).toBe("#2563eb");
      expect(update.title).toContain("2 MCP confirmation");
    });

    it("uses singular 'confirmation' for one pending prompt", () => {
      const update = badgeUpdateFor(args({ pendingPromptCount: 1 }));
      expect(update.text).toBe("1");
      expect(update.title).toMatch(/1 MCP confirmation awaiting/);
    });

    it("caps the badge text at 99 for sanity", () => {
      const update = badgeUpdateFor(args({ pendingPromptCount: 250 }));
      expect(update.text).toBe("99");
      // Title preserves the unsquished count for user clarity.
      expect(update.title).toContain("250");
    });

    it("renders blue '·' when only active tasks > 0", () => {
      const update = badgeUpdateFor(args({ activeTaskCount: 1 }));
      expect(update.text).toBe("·");
      expect(update.color).toBe("#2563eb");
      expect(update.title).toMatch(/1 MCP task running/);
    });

    it("prompts beat tasks when both are non-zero", () => {
      const update = badgeUpdateFor(
        args({ pendingPromptCount: 1, activeTaskCount: 5 }),
      );
      expect(update.text).toBe("1");
    });
  });

  describe("cleared badge", () => {
    it("clears for disconnected", () => {
      const update = badgeUpdateFor(
        args({ status: { kind: "disconnected" } }),
      );
      expect(update.text).toBe("");
      expect(update.color).toBeNull();
    });

    it("clears for connecting", () => {
      const update = badgeUpdateFor(
        args({ status: { kind: "connecting", attempt: 1 } }),
      );
      expect(update.text).toBe("");
      expect(update.color).toBeNull();
    });

    it("clears for connected with no MCP activity", () => {
      const update = badgeUpdateFor(args());
      expect(update.text).toBe("");
      expect(update.color).toBeNull();
      expect(update.title).toBe("OpenBrowse");
    });
  });
});

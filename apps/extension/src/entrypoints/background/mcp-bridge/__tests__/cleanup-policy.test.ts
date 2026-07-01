import { describe, expect, it } from "vitest";
import {
  decideTabCleanup,
  resolveTabCleanupPolicy,
  type TabCleanupOutcome,
  type TabCleanupPolicy,
} from "../cleanup-policy";

/**
 * Pure tests for the cleanup policy decision + migration helpers.
 * These live in `cleanup-policy.ts` (bundle-safe; no chrome / chat-db
 * imports) so the settings page can import the policy helpers without
 * dragging in the runtime layer.
 */

describe("cleanup-policy — decideTabCleanup", () => {
  const outcomes: TabCleanupOutcome[] = ["completed", "errored", "cancelled"];

  describe('policy "always-close"', () => {
    for (const outcome of outcomes) {
      it(`closes on ${outcome}`, () => {
        expect(decideTabCleanup("always-close", outcome)).toBe(true);
      });
    }
  });

  describe('policy "close-on-cancel-only"', () => {
    it("closes on cancelled", () => {
      expect(decideTabCleanup("close-on-cancel-only", "cancelled")).toBe(true);
    });
    it("does NOT close on completed", () => {
      expect(decideTabCleanup("close-on-cancel-only", "completed")).toBe(false);
    });
    it("does NOT close on errored", () => {
      expect(decideTabCleanup("close-on-cancel-only", "errored")).toBe(false);
    });
  });

  describe('policy "keep"', () => {
    for (const outcome of outcomes) {
      it(`never closes on ${outcome}`, () => {
        expect(decideTabCleanup("keep", outcome)).toBe(false);
      });
    }
  });
});

describe("cleanup-policy — resolveTabCleanupPolicy (migration)", () => {
  it("returns the explicit value when mcpAfterTaskTabPolicy is set", () => {
    expect(
      resolveTabCleanupPolicy({ mcpAfterTaskTabPolicy: "keep" }),
    ).toBe<TabCleanupPolicy>("keep");
    expect(
      resolveTabCleanupPolicy({
        mcpAfterTaskTabPolicy: "close-on-cancel-only",
      }),
    ).toBe<TabCleanupPolicy>("close-on-cancel-only");
    expect(
      resolveTabCleanupPolicy({ mcpAfterTaskTabPolicy: "always-close" }),
    ).toBe<TabCleanupPolicy>("always-close");
  });

  it("legacy mcpKeepTabsAfterCancel=true maps to 'keep'", () => {
    expect(
      resolveTabCleanupPolicy({ mcpKeepTabsAfterCancel: true }),
    ).toBe<TabCleanupPolicy>("keep");
  });

  it("legacy mcpKeepTabsAfterCancel=false defaults to 'always-close' (intentional behavior change)", () => {
    expect(
      resolveTabCleanupPolicy({ mcpKeepTabsAfterCancel: false }),
    ).toBe<TabCleanupPolicy>("always-close");
  });

  it("neither set: defaults to 'always-close'", () => {
    expect(resolveTabCleanupPolicy({})).toBe<TabCleanupPolicy>("always-close");
  });

  it("new field overrides legacy field when both are present", () => {
    expect(
      resolveTabCleanupPolicy({
        mcpAfterTaskTabPolicy: "close-on-cancel-only",
        mcpKeepTabsAfterCancel: true,
      }),
    ).toBe<TabCleanupPolicy>("close-on-cancel-only");
  });
});

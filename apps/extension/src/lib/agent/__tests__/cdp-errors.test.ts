/**
 * Unit tests for the side-effect-free CDP error classifiers.
 *
 * The classifiers gate two distinct recovery paths in `cdp-session` and
 * `snapshot-capture`. Misclassification is dangerous in both directions:
 *
 *   - If a cross-extension frame error is treated as a detach, we tear
 *     down a perfectly healthy session and retry the same whole-tree call,
 *     which fails identically and burns the retry budget.
 *   - If a real detach is treated as a cross-extension error, we keep
 *     using a dead session and every subsequent call fails.
 *
 * Hence: explicit unit tests on every Chrome error string we've seen in
 * the wild, and an assertion that the two predicates are mutually
 * exclusive on the strings we care about.
 */

import { describe, expect, it } from "vitest";
import { isCrossExtensionFrameError, isDetachError } from "../cdp-errors";

describe("isCrossExtensionFrameError", () => {
  const positive = [
    "Cannot access a chrome-extension:// URL of different extension",
    'Cannot access contents of url "chrome-extension://abc/inject.html". Extension manifest must request permission to access this host.',
    'Cannot access content of the url "chrome-extension://xyz/iframe.html"',
    // Mixed-case shouldn't matter
    "cannot access a chrome-extension:// url of different extension",
  ];

  for (const msg of positive) {
    it(`matches: ${msg.slice(0, 60)}…`, () => {
      expect(isCrossExtensionFrameError(new Error(msg))).toBe(true);
      expect(isCrossExtensionFrameError(msg)).toBe(true);
    });
  }

  const negative = [
    "Detached while handling command.",
    "No tab with given id 1234",
    "Target closed",
    "Debugger is not attached to the tab with id: 1234",
    "Cannot find context with specified id",
    "Some unrelated error",
    "",
  ];

  for (const msg of negative) {
    it(`does not match: ${msg.slice(0, 50)}`, () => {
      expect(isCrossExtensionFrameError(new Error(msg))).toBe(false);
    });
  }
});

describe("isDetachError x cross-extension exclusion", () => {
  it("does NOT classify the cross-extension error as a detach error", () => {
    // This is the critical invariant: a cross-extension frame error must
    // bypass the existing detach/retry path so the session isn't dropped.
    const err = new Error(
      "Cannot access a chrome-extension:// URL of different extension",
    );
    expect(isCrossExtensionFrameError(err)).toBe(true);
    expect(isDetachError(err)).toBe(false);
  });

  it("still classifies real detach errors as detach errors", () => {
    expect(isDetachError(new Error("Detached while handling command."))).toBe(
      true,
    );
    expect(isDetachError(new Error("No tab with given id 5"))).toBe(true);
    expect(isDetachError(new Error("Target closed"))).toBe(true);
  });
});

import { describe, expect, it } from "vitest";
import { isInternalChromeUrl } from "../tab-legend";

/**
 * Locks in the invariant relied on by the newtab entrypoint design:
 * newtab.html is served from chrome-extension://<id>/newtab.html, and
 * the codebase-wide filter for "is this an extension/internal page?"
 * already returns true for any chrome-extension:// URL. If a future
 * refactor narrows that filter (e.g. to a hardcoded list of paths),
 * the agent would start trying to drive the user's NTP. This test
 * fails loudly when that happens.
 */
describe("isInternalChromeUrl — newtab.html", () => {
  it("treats our newtab page as internal/extension (not an agent target)", () => {
    expect(
      isInternalChromeUrl("chrome-extension://abc123/newtab.html"),
    ).toBe(true);
  });

  it("treats our home page as internal/extension (regression guard)", () => {
    expect(
      isInternalChromeUrl("chrome-extension://abc123/home.html"),
    ).toBe(true);
  });
});

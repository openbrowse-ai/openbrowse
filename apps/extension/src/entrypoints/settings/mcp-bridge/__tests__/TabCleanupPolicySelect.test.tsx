import { describe, expect, it } from "vitest";
import {
  TAB_CLEANUP_OPTIONS,
  resolveSelectedPolicy,
} from "../TabCleanupPolicySelect";

describe("TabCleanupPolicySelect — options", () => {
  it("exposes always-close / close-on-cancel-only / keep in order", () => {
    expect(TAB_CLEANUP_OPTIONS.map((o) => o.value)).toEqual([
      "always-close",
      "close-on-cancel-only",
      "keep",
    ]);
  });

  it("pairs every value with a non-empty human label", () => {
    for (const opt of TAB_CLEANUP_OPTIONS) {
      expect(opt.label.length).toBeGreaterThan(0);
    }
  });

  it("attaches an explanatory caption to every option", () => {
    for (const opt of TAB_CLEANUP_OPTIONS) {
      expect(opt.caption.length).toBeGreaterThan(0);
    }
  });
});

describe("TabCleanupPolicySelect — resolveSelectedPolicy", () => {
  it("returns the stored value when set", () => {
    expect(
      resolveSelectedPolicy({ mcpAfterTaskTabPolicy: "keep" }),
    ).toBe("keep");
    expect(
      resolveSelectedPolicy({ mcpAfterTaskTabPolicy: "close-on-cancel-only" }),
    ).toBe("close-on-cancel-only");
    expect(
      resolveSelectedPolicy({ mcpAfterTaskTabPolicy: "always-close" }),
    ).toBe("always-close");
  });

  it("legacy mcpKeepTabsAfterCancel=true falls back to 'keep'", () => {
    expect(
      resolveSelectedPolicy({ mcpKeepTabsAfterCancel: true }),
    ).toBe("keep");
  });

  it("defaults to 'always-close' when nothing is stored", () => {
    expect(resolveSelectedPolicy({})).toBe("always-close");
  });

  it("new field overrides legacy field", () => {
    expect(
      resolveSelectedPolicy({
        mcpAfterTaskTabPolicy: "close-on-cancel-only",
        mcpKeepTabsAfterCancel: true,
      }),
    ).toBe("close-on-cancel-only");
  });
});

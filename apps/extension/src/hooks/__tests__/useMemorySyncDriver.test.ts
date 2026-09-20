import { describe, expect, it } from "vitest";

import { VFS_DEBOUNCE_MS, qualifiesForSync } from "@/hooks/useMemorySyncDriver";

// Following house style (see AutoDenyTimeoutSelect.test.tsx), the testable part
// of a hook is its exported policy, not its React wiring.

describe("qualifiesForSync", () => {
  it("accepts writes anywhere under the global memory tree", () => {
    expect(qualifiesForSync("memory/garry-tan.md")).toBe(true);
    expect(qualifiesForSync("memory/people/garry-tan.md")).toBe(true);
  });

  it("accepts the directory path itself", () => {
    // A recursive directory delete emits the directory's own path, not the files
    // it contained — matching on `.md` would miss the deletion entirely.
    expect(qualifiesForSync("memory/people")).toBe(true);
  });

  it("ignores space-scoped memory, which v1 does not sync", () => {
    expect(qualifiesForSync("spaces/abc/memory/x.md")).toBe(false);
  });

  it("ignores writes outside memory", () => {
    expect(qualifiesForSync("conversations/1/workspace/notes.md")).toBe(false);
    expect(qualifiesForSync("skills/foo/SKILL.md")).toBe(false);
    // Must not match a sibling directory that merely starts with the same letters.
    expect(qualifiesForSync("memorydump/x.md")).toBe(false);
  });

  it("tolerates a missing or non-string path", () => {
    expect(qualifiesForSync(undefined)).toBe(false);
    expect(qualifiesForSync(null)).toBe(false);
    expect(qualifiesForSync(42)).toBe(false);
  });
});

describe("VFS_DEBOUNCE_MS", () => {
  it("is long enough to coalesce a burst of writes but short enough to feel prompt", () => {
    // An agent authoring several notes in one turn emits a change per file; this
    // window collapses them into a single pass.
    expect(VFS_DEBOUNCE_MS).toBeGreaterThanOrEqual(1_000);
    expect(VFS_DEBOUNCE_MS).toBeLessThanOrEqual(10_000);
  });
});

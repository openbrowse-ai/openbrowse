import { describe, expect, it } from "vitest";

import {
  classifyRemotePath,
  isSafeRelPath,
  isSyncableLocalPath,
} from "../paths";

// A vault is a user-chosen directory that may be shared, cloud-synced, or
// checked into a repo, so its contents are untrusted input. These are the tests
// that keep a hostile or merely messy vault from writing outside `memory/**`.

describe("isSafeRelPath", () => {
  it("accepts ordinary nested memory paths", () => {
    expect(isSafeRelPath("memory/garry-tan.md")).toBe(true);
    expect(isSafeRelPath("memory/people/garry-tan.md")).toBe(true);
  });

  it("rejects traversal in any position", () => {
    expect(isSafeRelPath("../escape.md")).toBe(false);
    expect(isSafeRelPath("memory/../escape.md")).toBe(false);
    expect(isSafeRelPath("memory/../../escape.md")).toBe(false);
    expect(isSafeRelPath("memory/people/../../escape.md")).toBe(false);
    expect(isSafeRelPath("memory/./x.md")).toBe(false);
  });

  it("rejects absolute paths and empty segments", () => {
    expect(isSafeRelPath("/memory/x.md")).toBe(false);
    expect(isSafeRelPath("memory//x.md")).toBe(false);
    expect(isSafeRelPath("")).toBe(false);
  });

  it("rejects backslashes, which a producer may intend as separators", () => {
    expect(isSafeRelPath("memory\\x.md")).toBe(false);
    expect(isSafeRelPath("memory/sub\\x.md")).toBe(false);
  });

  it("rejects dotted segments, which is what hides sync metadata", () => {
    // `.openbrowse/**` holds the manifest, tombstones, conflicts, and lock.
    // Refusing dotted segments is what stops metadata from ever being mistaken
    // for a memory note.
    expect(isSafeRelPath(".openbrowse/vault.json")).toBe(false);
    expect(isSafeRelPath("memory/.hidden.md")).toBe(false);
    expect(isSafeRelPath("memory/.git/config")).toBe(false);
  });

  it("rejects control characters and NUL", () => {
    expect(isSafeRelPath("memory/a\u0000b.md")).toBe(false);
    expect(isSafeRelPath("memory/a\nb.md")).toBe(false);
    expect(isSafeRelPath("memory/a\rb.md")).toBe(false);
  });

  it("rejects pathologically long paths", () => {
    expect(isSafeRelPath(`memory/${"a".repeat(600)}.md`)).toBe(false);
  });
});

describe("classifyRemotePath", () => {
  it("accepts global memory markdown", () => {
    expect(classifyRemotePath("memory/x.md")).toBeNull();
    expect(classifyRemotePath("memory/nested/deep/x.md")).toBeNull();
  });

  it("refuses non-markdown files", () => {
    expect(classifyRemotePath("memory/notes.txt")).toBe("not-global-memory");
    expect(classifyRemotePath("memory/image.png")).toBe("not-global-memory");
  });

  it("refuses space-scoped memory, which has no portable identity", () => {
    // `Space.id` is a per-profile UUID, so a space path from another profile is
    // meaningless here. v1 syncs global memory only.
    expect(classifyRemotePath("spaces/abc-123/memory/x.md")).toBe(
      "not-global-memory",
    );
  });

  it("refuses anything outside the memory tree", () => {
    expect(classifyRemotePath("conversations/1/workspace/x.md")).toBe(
      "not-global-memory",
    );
    expect(classifyRemotePath("skills/evil/SKILL.md")).toBe(
      "not-global-memory",
    );
    expect(classifyRemotePath("x.md")).toBe("not-global-memory");
  });

  it("reports traversal as unsafe rather than merely out of scope", () => {
    expect(classifyRemotePath("memory/../evil.md")).toBe("unsafe-path");
  });

  it("agrees with isSyncableLocalPath", () => {
    expect(isSyncableLocalPath("memory/x.md")).toBe(true);
    expect(isSyncableLocalPath("memory/x.md.tmp-abc123")).toBe(false);
    expect(isSyncableLocalPath("spaces/a/memory/x.md")).toBe(false);
  });
});

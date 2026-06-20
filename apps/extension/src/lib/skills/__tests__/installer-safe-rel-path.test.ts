/**
 * Direct tests for `safeRelPath` — the path-traversal sanitization
 * helper used by upsertSiteSkill / patchSiteSkill.
 *
 * Replaces a previous regex-strip implementation that CodeQL flagged
 * as "Incomplete multi-character sanitization" because the regex was
 * single-pass and could leave `../` standing after one strip iteration
 * (input `....//x` → `../x`). The new implementation throws on any
 * `..` segment after split-and-normalize.
 */
import { describe, it, expect } from "vitest";
import { _internals } from "../installer";

const { safeRelPath } = _internals;

describe("safeRelPath", () => {
  it("passes a plain relative path through unchanged", () => {
    expect(safeRelPath("foo.js")).toBe("foo.js");
    expect(safeRelPath("scripts/foo.js")).toBe("scripts/foo.js");
    expect(safeRelPath("a/b/c.js")).toBe("a/b/c.js");
  });

  it("strips leading slashes", () => {
    expect(safeRelPath("/foo.js")).toBe("foo.js");
    expect(safeRelPath("///foo.js")).toBe("foo.js");
    expect(safeRelPath("/scripts/foo.js")).toBe("scripts/foo.js");
  });

  it("collapses `.` segments", () => {
    expect(safeRelPath("./foo.js")).toBe("foo.js");
    expect(safeRelPath("scripts/./foo.js")).toBe("scripts/foo.js");
  });

  it("throws on simple `..` traversal", () => {
    expect(() => safeRelPath("../etc/passwd")).toThrow(
      /Path traversal not allowed/,
    );
  });

  it("does NOT produce a traversal output on the multi-pass-strip exploit", () => {
    // The previous regex `s.path.replace(/^\/+/, "").replace(/\.\.\//g, "")`
    // would convert `....//etc` to `../etc` in one pass — leaving a real
    // `..` segment standing in the OUTPUT (the very thing the strip was
    // meant to prevent). The split-and-walk implementation never produces
    // a `..` segment in the output: `....//etc` splits to ["....", "etc"]
    // — `....` is an unusual but harmless filename, and the result joins
    // to `..../etc` (no traversal).
    expect(safeRelPath("....//etc")).toBe("..../etc");
  });

  it("throws on a literal `..` segment regardless of surrounding chars", () => {
    // After split-on-`/`, any segment that exactly equals `..` is a
    // traversal attempt. Surrounding empty segments (from leading/
    // doubled slashes) are filtered before the check.
    expect(() => safeRelPath("/..")).toThrow(/Path traversal not allowed/);
    expect(() => safeRelPath("foo/..")).toThrow(/Path traversal not allowed/);
    expect(() => safeRelPath("..//foo")).toThrow(/Path traversal not allowed/);
  });

  it("throws on embedded `..` segments", () => {
    expect(() => safeRelPath("foo/../bar")).toThrow(
      /Path traversal not allowed/,
    );
    expect(() => safeRelPath("foo/bar/../../etc")).toThrow(
      /Path traversal not allowed/,
    );
  });

  it("does NOT mistake filename segments containing `..` for traversal", () => {
    // `..foo` and `foo..bar` are valid (if unusual) filenames; only an
    // exact-match `..` segment is rejected.
    expect(safeRelPath("..foo.js")).toBe("..foo.js");
    expect(safeRelPath("foo..bar.js")).toBe("foo..bar.js");
  });

  it("error message names the offending input", () => {
    try {
      safeRelPath("../etc/passwd");
      throw new Error("expected throw");
    } catch (e) {
      expect((e as Error).message).toContain("../etc/passwd");
    }
  });
});

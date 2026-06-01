import { describe, expect, it } from "vitest";
import { buildMemoryDiff, buildAdditionDiff } from "../tool-results/memory";

describe("buildAdditionDiff", () => {
  it("prefixes every line with +", () => {
    expect(buildAdditionDiff("a\nb")).toBe("+ a\n+ b");
  });
  it("returns empty for empty content", () => {
    expect(buildAdditionDiff("")).toBe("");
  });
});

describe("buildMemoryDiff", () => {
  it("marks unchanged lines as context", () => {
    expect(buildMemoryDiff("a\nb", "a\nb")).toBe("  a\n  b");
  });

  it("marks an added line with +", () => {
    expect(buildMemoryDiff("a\nb", "a\nb\nc")).toBe("  a\n  b\n+ c");
  });

  it("marks a removed line with -", () => {
    expect(buildMemoryDiff("a\nb\nc", "a\nc")).toBe("  a\n- b\n  c");
  });

  it("handles a replacement (remove + add)", () => {
    const diff = buildMemoryDiff("hello\nworld", "hello\nthere");
    expect(diff).toContain("  hello");
    expect(diff).toContain("- world");
    expect(diff).toContain("+ there");
  });

  it("all additions when old content is empty", () => {
    expect(buildMemoryDiff("", "x\ny")).toBe("+ x\n+ y");
  });

  it("all removals when new content is empty", () => {
    expect(buildMemoryDiff("x\ny", "")).toBe("- x\n- y");
  });
});

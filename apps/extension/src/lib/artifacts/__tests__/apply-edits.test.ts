import { describe, it, expect } from "vitest";
import { applyEdits } from "../apply-edits";

describe("applyEdits", () => {
  it("applies a single edit", () => {
    expect(applyEdits("hello world", [{ find: "world", replace: "there" }])).toBe(
      "hello there",
    );
  });

  it("applies edits sequentially and cumulatively", () => {
    const out = applyEdits("a b c", [
      { find: "a", replace: "x" },
      { find: "x b", replace: "y" },
    ]);
    expect(out).toBe("y c");
  });

  it("inserts $-sequences in replace literally", () => {
    expect(applyEdits("price", [{ find: "price", replace: "$5 & $10" }])).toBe(
      "$5 & $10",
    );
  });

  it("rejects an empty edit list", () => {
    expect(() => applyEdits("x", [])).toThrow(/at least one/);
  });

  it("rejects an empty find", () => {
    expect(() => applyEdits("x", [{ find: "", replace: "y" }])).toThrow(
      /edit #1: 'find' must not be empty/,
    );
  });

  it("rejects when find is not present (names the edit index)", () => {
    expect(() =>
      applyEdits("hello", [{ find: "world", replace: "x" }]),
    ).toThrow(/edit #1: 'find' not found/);
  });

  it("rejects when find matches more than once (reports count)", () => {
    expect(() =>
      applyEdits("aa", [{ find: "a", replace: "b" }]),
    ).toThrow(/edit #1: 'find' matched 2 times \(must be unique\)/);
  });

  it("reports the correct index for a later failing edit", () => {
    expect(() =>
      applyEdits("one two", [
        { find: "one", replace: "1" },
        { find: "three", replace: "3" },
      ]),
    ).toThrow(/edit #2: 'find' not found/);
  });
});

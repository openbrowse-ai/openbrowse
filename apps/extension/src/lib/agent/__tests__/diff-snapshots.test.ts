import { describe, expect, it } from "vitest";
import {
  diffSnapshots,
  type PageStateSignals,
} from "../snapshot-capture";

const ZERO: PageStateSignals = {
  focusedBackendNodeId: null,
  focusedName: null,
  focusedRole: null,
  expandedCount: 0,
  pressedCount: 0,
  checkedCount: 0,
  dialogCount: 0,
  url: "https://example.com",
};

describe("diffSnapshots — null cases", () => {
  it("returns null when text and signals are both unchanged", () => {
    const result = diffSnapshots(
      { text: "a\nb\nc", signals: ZERO },
      { text: "a\nb\nc", signals: ZERO },
    );
    expect(result).toBeNull();
  });
});

describe("diffSnapshots — signal-only changes (text identical)", () => {
  it("reports focus moves", () => {
    const result = diffSnapshots(
      { text: "a", signals: { ...ZERO, focusedBackendNodeId: 1, focusedName: "Email" } },
      { text: "a", signals: { ...ZERO, focusedBackendNodeId: 2, focusedName: "Password" } },
    );
    expect(result).toMatch(/^\[no a11y text change, but: /);
    expect(result).toContain("focus moved");
    expect(result).toContain("Email");
    expect(result).toContain("Password");
  });

  it("reports aria-expanded count change", () => {
    const result = diffSnapshots(
      { text: "a", signals: { ...ZERO, expandedCount: 0 } },
      { text: "a", signals: { ...ZERO, expandedCount: 1 } },
    );
    expect(result).toContain("aria-expanded count: 0 → 1");
  });

  it("reports aria-pressed and aria-checked count changes", () => {
    const result = diffSnapshots(
      { text: "a", signals: { ...ZERO, pressedCount: 0, checkedCount: 1 } },
      { text: "a", signals: { ...ZERO, pressedCount: 1, checkedCount: 0 } },
    );
    expect(result).toContain("aria-pressed count: 0 → 1");
    expect(result).toContain("aria-checked count: 1 → 0");
  });

  it("reports dialog opening", () => {
    const result = diffSnapshots(
      { text: "a", signals: { ...ZERO, dialogCount: 0 } },
      { text: "a", signals: { ...ZERO, dialogCount: 1 } },
    );
    expect(result).toContain("dialog opened");
  });

  it("reports dialog closing", () => {
    const result = diffSnapshots(
      { text: "a", signals: { ...ZERO, dialogCount: 1 } },
      { text: "a", signals: { ...ZERO, dialogCount: 0 } },
    );
    expect(result).toContain("dialog closed");
  });

  it("reports URL change", () => {
    const result = diffSnapshots(
      { text: "a", signals: { ...ZERO, url: "https://a.test" } },
      { text: "a", signals: { ...ZERO, url: "https://b.test" } },
    );
    expect(result).toContain("navigated to https://b.test");
  });

  it("does NOT report a URL change when the new URL is empty (failed fetch)", () => {
    // A real prior URL → "" (Target.getTargetInfo failed) must not emit a
    // spurious "navigated to " with an empty target.
    const result = diffSnapshots(
      { text: "a", signals: { ...ZERO, url: "https://a.test" } },
      { text: "a", signals: { ...ZERO, url: "" } },
    );
    expect(result).toBeNull();
  });

  it("does NOT report a URL change when the prior URL is empty", () => {
    const result = diffSnapshots(
      { text: "a", signals: { ...ZERO, url: "" } },
      { text: "a", signals: { ...ZERO, url: "https://b.test" } },
    );
    expect(result).toBeNull();
  });

  // `interactiveCount` was removed from PageStateSignals entirely (it was
  // mode-fragile and dead code after the diff→viewport-snapshot migration).
  // The structural impossibility of diffing it is now the regression
  // guarantee — no runtime test needed. See `describeSignalChanges` in
  // snapshot-capture for context.

  it("joins multiple changes with semicolons", () => {
    const result = diffSnapshots(
      { text: "a", signals: { ...ZERO, dialogCount: 0, expandedCount: 0 } },
      { text: "a", signals: { ...ZERO, dialogCount: 1, expandedCount: 2 } },
    );
    expect(result).toMatch(/dialog opened.*aria-expanded count|aria-expanded count.*dialog opened/);
    expect(result).toContain(";");
  });

  it("reports focus lost (focused → none)", () => {
    const result = diffSnapshots(
      { text: "a", signals: { ...ZERO, focusedBackendNodeId: 1, focusedName: "Email" } },
      { text: "a", signals: { ...ZERO, focusedBackendNodeId: null, focusedName: null } },
    );
    expect(result).toContain("focus moved");
    expect(result).toContain("Email");
    expect(result).toContain("«none»");
  });

  it("reports dialog count change between non-zero values", () => {
    const result = diffSnapshots(
      { text: "a", signals: { ...ZERO, dialogCount: 2 } },
      { text: "a", signals: { ...ZERO, dialogCount: 3 } },
    );
    expect(result).toContain("dialog count: 2 → 3");
    // Should NOT use the "opened"/"closed" phrasing for non-zero transitions.
    expect(result).not.toContain("dialog opened");
    expect(result).not.toContain("dialog closed");
  });
});

describe("diffSnapshots — text changes (regression)", () => {
  it("returns line diff when text changed and signals identical", () => {
    const result = diffSnapshots(
      { text: "a\nb\nc", signals: ZERO },
      { text: "a\nb\nc\nd", signals: ZERO },
    );
    expect(result).toContain("[+] d");
  });

  it("text diff takes precedence — does not also append signal info", () => {
    const result = diffSnapshots(
      { text: "a", signals: { ...ZERO, dialogCount: 0 } },
      { text: "a\nb", signals: { ...ZERO, dialogCount: 1 } },
    );
    expect(result).toContain("[+] b");
    expect(result).not.toContain("dialog opened");
  });

  it("truncates large diffs (regression)", () => {
    const big = Array.from({ length: 100 }, (_, i) => `line${i}`).join("\n");
    const result = diffSnapshots(
      { text: "", signals: ZERO },
      { text: big, signals: ZERO },
    );
    expect(result).toMatch(/major change/);
  });
});

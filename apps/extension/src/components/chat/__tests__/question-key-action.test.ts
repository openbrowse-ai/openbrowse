import { describe, expect, it } from "vitest";
import {
  type QuestionKeyContext,
  resolveQuestionKeyAction,
} from "../question-key-action";

/** Focus in the scroll body of a 2-question card with 4 options. */
function ctx(overrides: Partial<QuestionKeyContext> = {}): QuestionKeyContext {
  return {
    key: "ArrowRight",
    inTextEntry: false,
    onButton: false,
    multi: true,
    optionCount: 4,
    ...overrides,
  };
}

describe("resolveQuestionKeyAction — arrows", () => {
  it("navigates on bare ← / →", () => {
    expect(resolveQuestionKeyAction(ctx({ key: "ArrowRight" }))).toEqual({
      kind: "navigate",
      delta: 1,
    });
    expect(resolveQuestionKeyAction(ctx({ key: "ArrowLeft" }))).toEqual({
      kind: "navigate",
      delta: -1,
    });
  });

  it("navigates on a bare arrow while an option button holds focus", () => {
    // Clicking an option leaves focus on that button, so this is the
    // single most common state the user presses an arrow from.
    expect(resolveQuestionKeyAction(ctx({ onButton: true }))).toEqual({
      kind: "navigate",
      delta: 1,
    });
  });

  it("leaves bare arrows to the caret inside the free-text box", () => {
    expect(resolveQuestionKeyAction(ctx({ inTextEntry: true }))).toEqual({
      kind: "ignore",
    });
  });

  it.each(["altKey", "metaKey", "ctrlKey"] as const)(
    "still navigates from the free-text box with %s held",
    (mod) => {
      // The escape hatch: focus naturally lives in the box once the user
      // starts typing, so a modified arrow has to keep working there.
      expect(
        resolveQuestionKeyAction(ctx({ inTextEntry: true, [mod]: true })),
      ).toEqual({ kind: "navigate", delta: 1 });
    },
  );

  it("ignores arrows when there is only one question", () => {
    expect(resolveQuestionKeyAction(ctx({ multi: false }))).toEqual({
      kind: "ignore",
    });
    expect(
      resolveQuestionKeyAction(ctx({ multi: false, altKey: true })),
    ).toEqual({ kind: "ignore" });
  });
});

describe("resolveQuestionKeyAction — Enter", () => {
  it("runs the primary action on bare Enter", () => {
    expect(resolveQuestionKeyAction(ctx({ key: "Enter" }))).toEqual({
      kind: "primary",
    });
  });

  it("runs the primary action on Enter from inside the free-text box", () => {
    // Matches ChatInput: Enter sends, Shift+Enter is the newline.
    expect(
      resolveQuestionKeyAction(ctx({ key: "Enter", inTextEntry: true })),
    ).toEqual({ kind: "primary" });
  });

  it.each(["shiftKey", "altKey"] as const)(
    "yields Enter to the field when %s is held, so a newline can be typed",
    (mod) => {
      expect(
        resolveQuestionKeyAction(ctx({ key: "Enter", [mod]: true })),
      ).toEqual({ kind: "ignore" });
    },
  );

  it("yields Enter to a focused button so it isn't handled twice", () => {
    // Otherwise the button's own onClick AND the primary action both fire.
    expect(
      resolveQuestionKeyAction(ctx({ key: "Enter", onButton: true })),
    ).toEqual({ kind: "ignore" });
  });

  it.each(["metaKey", "ctrlKey"] as const)("dismisses on %s+Enter", (mod) => {
    expect(
      resolveQuestionKeyAction(ctx({ key: "Enter", [mod]: true })),
    ).toEqual({ kind: "dismiss" });
  });

  it("dismisses on Cmd+Enter even from a focused button or the text box", () => {
    expect(
      resolveQuestionKeyAction(
        ctx({ key: "Enter", metaKey: true, onButton: true }),
      ),
    ).toEqual({ kind: "dismiss" });
    expect(
      resolveQuestionKeyAction(
        ctx({ key: "Enter", metaKey: true, inTextEntry: true }),
      ),
    ).toEqual({ kind: "dismiss" });
  });
});

describe("resolveQuestionKeyAction — number keys", () => {
  it("picks the option at the pressed position", () => {
    expect(resolveQuestionKeyAction(ctx({ key: "1" }))).toEqual({
      kind: "pickOption",
      optionIndex: 0,
    });
    expect(resolveQuestionKeyAction(ctx({ key: "4" }))).toEqual({
      kind: "pickOption",
      optionIndex: 3,
    });
  });

  it("picks while a button holds focus, as it does after a click", () => {
    expect(resolveQuestionKeyAction(ctx({ key: "2", onButton: true }))).toEqual({
      kind: "pickOption",
      optionIndex: 1,
    });
  });

  it("ignores digits past the end of the option list", () => {
    expect(resolveQuestionKeyAction(ctx({ key: "5" }))).toEqual({
      kind: "ignore",
    });
  });

  it("ignores 0, which would be option index -1", () => {
    expect(resolveQuestionKeyAction(ctx({ key: "0" }))).toEqual({
      kind: "ignore",
    });
  });

  it("lets digits type into the free-text box", () => {
    expect(
      resolveQuestionKeyAction(ctx({ key: "2", inTextEntry: true })),
    ).toEqual({ kind: "ignore" });
  });

  it("ignores digits with a modifier, leaving browser shortcuts alone", () => {
    // Cmd+1 switches tab in Chrome; we must not swallow it.
    expect(resolveQuestionKeyAction(ctx({ key: "1", metaKey: true }))).toEqual({
      kind: "ignore",
    });
  });
});

describe("resolveQuestionKeyAction — everything else", () => {
  it.each(["Escape", "Tab", "a", " ", "ArrowUp", "ArrowDown"])(
    "ignores %s",
    (key) => {
      // ArrowUp/ArrowDown are deliberately NOT bound: the question body
      // scrolls, and hijacking them would break that.
      expect(resolveQuestionKeyAction(ctx({ key }))).toEqual({
        kind: "ignore",
      });
    },
  );
});

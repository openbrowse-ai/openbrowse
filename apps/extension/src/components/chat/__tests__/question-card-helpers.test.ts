import type { AskUserQuestion } from "@/lib/agent/tools/ask-user";
import { describe, expect, it } from "vitest";
import {
  applyOptionPick,
  applyOtherText,
  buildAskUserOutput,
  canRunPrimary,
  isQuestionAnswered,
} from "../QuestionCard";

/**
 * `Draft` is intentionally not exported from QuestionCard — these literals
 * match it structurally, which is all the helpers need.
 */
function draft(selected: string[] = [], other = "") {
  return { selected, other };
}

const BLANK = draft();
const ANSWERED = draft(["Nonstop"]);

function question(overrides: Partial<AskUserQuestion> = {}): AskUserQuestion {
  return {
    question: "Which flight?",
    header: "Flight",
    multiSelect: false,
    options: [
      { label: "Nonstop", description: "Costs more" },
      { label: "One stop", description: "Cheapest" },
    ],
    ...overrides,
  };
}

const SEAT = question({
  question: "Which seat?",
  header: "Seat",
  options: [
    { label: "Aisle", description: "a" },
    { label: "Window", description: "b" },
  ],
});

describe("isQuestionAnswered", () => {
  it("is false for an untouched draft", () => {
    expect(isQuestionAnswered(draft())).toBe(false);
  });

  it("is true once an option is selected", () => {
    expect(isQuestionAnswered(draft(["Nonstop"]))).toBe(true);
  });

  it("is true when only free text was typed", () => {
    expect(isQuestionAnswered(draft([], "red-eye if it is cheaper"))).toBe(true);
  });

  it("treats whitespace-only free text as unanswered", () => {
    expect(isQuestionAnswered(draft([], "   \n\t "))).toBe(false);
  });

  it("counts multiline free text as answered", () => {
    // The free-text box is a textarea, so a custom answer can span lines.
    expect(isQuestionAnswered(draft([], "one stop\nbut only before noon"))).toBe(
      true,
    );
  });
});

const MULTI = question({
  multiSelect: true,
  options: [
    { label: "Nonstop", description: "a" },
    { label: "Morning", description: "b" },
  ],
});

describe("canRunPrimary", () => {
  it("blocks advancing while the question on screen is unanswered", () => {
    // The reported behaviour: "Next question" walked past an untouched
    // question, which read as though an answer had been accepted.
    expect(canRunPrimary([BLANK, BLANK, BLANK], 0)).toBe(false);
  });

  it("allows advancing once the question on screen is answered", () => {
    expect(canRunPrimary([ANSWERED, BLANK, BLANK], 0)).toBe(true);
  });

  it("ignores later questions when deciding whether to advance", () => {
    expect(canRunPrimary([ANSWERED, BLANK, BLANK], 0)).toBe(true);
    expect(canRunPrimary([BLANK, ANSWERED, ANSWERED], 0)).toBe(false);
  });

  it("allows submitting on the last question when an earlier one is answered", () => {
    // Reachable by arrowing forward past a question. Requiring the last
    // one too would strand the user with answers they cannot send.
    expect(canRunPrimary([ANSWERED, BLANK], 1)).toBe(true);
  });

  it("blocks submitting when nothing at all is answered", () => {
    // Would report `answered` with an empty `answers` array.
    expect(canRunPrimary([BLANK, BLANK], 1)).toBe(false);
  });

  it("requires an answer for a lone question, which is also the last", () => {
    expect(canRunPrimary([BLANK], 0)).toBe(false);
    expect(canRunPrimary([ANSWERED], 0)).toBe(true);
  });
});

describe("applyOptionPick", () => {
  it("selects exactly one option in single-select", () => {
    expect(applyOptionPick(draft(), question(), "Nonstop")).toEqual({
      selected: ["Nonstop"],
      other: "",
    });
  });

  it("replaces the previous pick in single-select", () => {
    expect(applyOptionPick(draft(["Nonstop"]), question(), "One stop")).toEqual({
      selected: ["One stop"],
      other: "",
    });
  });

  it("clears the pick when the same option is clicked again", () => {
    // Lets the user back out of a choice without answering.
    expect(applyOptionPick(draft(["Nonstop"]), question(), "Nonstop")).toEqual({
      selected: [],
      other: "",
    });
  });

  it("discards typed text when an option is picked in single-select", () => {
    // The field reads "Or type your own answer" — picking is the other
    // branch of that "or", so the typed answer goes.
    expect(
      applyOptionPick(draft([], "something bespoke"), question(), "Nonstop"),
    ).toEqual({ selected: ["Nonstop"], other: "" });
  });

  it("accumulates options in multi-select", () => {
    expect(applyOptionPick(draft(["Nonstop"]), MULTI, "Morning")).toEqual({
      selected: ["Nonstop", "Morning"],
      other: "",
    });
  });

  it("removes an already-checked option in multi-select", () => {
    expect(
      applyOptionPick(draft(["Nonstop", "Morning"]), MULTI, "Nonstop"),
    ).toEqual({ selected: ["Morning"], other: "" });
  });

  it("keeps typed text when picking in multi-select", () => {
    // These choices combine rather than compete, so a typed answer
    // combines with them too.
    expect(applyOptionPick(draft([], "avoid Spirit"), MULTI, "Nonstop")).toEqual({
      selected: ["Nonstop"],
      other: "avoid Spirit",
    });
  });
});

describe("applyOtherText", () => {
  it("clears a picked option once real text is typed in single-select", () => {
    // The reported bug: option 1 stayed checked while a custom answer was
    // typed, leaving the card self-contradictory and the output ambiguous.
    expect(applyOtherText(draft(["Nonstop"]), question(), "asdfa sd")).toEqual({
      selected: [],
      other: "asdfa sd",
    });
  });

  it("keeps the pick while the box holds only whitespace", () => {
    // A stray space must not silently discard a deliberate choice.
    expect(applyOtherText(draft(["Nonstop"]), question(), "  ")).toEqual({
      selected: ["Nonstop"],
      other: "  ",
    });
  });

  it("does not restore the option when the box is emptied again", () => {
    const typed = applyOtherText(draft(["Nonstop"]), question(), "bespoke");
    expect(applyOtherText(typed, question(), "")).toEqual({
      selected: [],
      other: "",
    });
  });

  it("keeps checked options in multi-select", () => {
    expect(applyOtherText(draft(["Nonstop"]), MULTI, "avoid Spirit")).toEqual({
      selected: ["Nonstop"],
      other: "avoid Spirit",
    });
  });

  it("never yields both a pick and free text in single-select", () => {
    // Property check over the two mutations in both orders.
    const typedThenPicked = applyOptionPick(
      applyOtherText(draft(), question(), "bespoke"),
      question(),
      "Nonstop",
    );
    const pickedThenTyped = applyOtherText(
      applyOptionPick(draft(), question(), "Nonstop"),
      question(),
      "bespoke",
    );
    for (const d of [typedThenPicked, pickedThenTyped]) {
      expect(d.selected.length > 0 && d.other.trim().length > 0).toBe(false);
    }
  });
});

describe("buildAskUserOutput", () => {
  it("echoes question text and header so the result is self-describing", () => {
    const output = buildAskUserOutput(
      [question()],
      [draft(["Nonstop"])],
      "answered",
    );

    expect(output).toEqual({
      outcome: "answered",
      answers: [
        {
          question: "Which flight?",
          header: "Flight",
          selected: ["Nonstop"],
        },
      ],
    });
  });

  it("orders `selected` by presentation, not by click order", () => {
    // The model reads these back against the options it authored, so the
    // array follows the option list rather than the order the user clicked.
    const questions = [
      question({
        multiSelect: true,
        options: [
          { label: "Cheapest", description: "a" },
          { label: "Fastest", description: "b" },
          { label: "Fewest stops", description: "c" },
        ],
      }),
    ];
    const drafts = [draft(["Fewest stops", "Cheapest"])];

    expect(
      buildAskUserOutput(questions, drafts, "answered").answers[0].selected,
    ).toEqual(["Cheapest", "Fewest stops"]);
  });

  it("drops selections that are not options on the question", () => {
    const drafts = [draft(["Nonstop", "Teleport"])];

    expect(
      buildAskUserOutput([question()], drafts, "answered").answers[0].selected,
    ).toEqual(["Nonstop"]);
  });

  it("preserves newlines in free text and trims the edges", () => {
    const drafts = [draft([], "  one stop\nbut only before noon  ")];

    expect(
      buildAskUserOutput([question()], drafts, "answered").answers[0],
    ).toEqual({
      question: "Which flight?",
      header: "Flight",
      selected: [],
      other: "one stop\nbut only before noon",
    });
  });

  it("omits `other` entirely when the field is blank", () => {
    const drafts = [draft(["Nonstop"], "   ")];

    expect(
      "other" in buildAskUserOutput([question()], drafts, "answered").answers[0],
    ).toBe(false);
  });

  it("keeps one answer per question, in order", () => {
    const questions = [question(), SEAT];
    const drafts = [draft(["One stop"]), draft(["Window"])];

    expect(
      buildAskUserOutput(questions, drafts, "answered").answers.map((a) => [
        a.header,
        a.selected,
      ]),
    ).toEqual([
      ["Flight", ["One stop"]],
      ["Seat", ["Window"]],
    ]);
  });

  it("omits questions the user skipped rather than emitting empty answers", () => {
    // The user can submit from the last question without answering every
    // one. An empty `selected` would read as "replied and said nothing";
    // omitting it reads as "didn't answer", which is what happened.
    const questions = [question(), SEAT];
    const drafts = [draft(), draft(["Aisle"])];

    expect(buildAskUserOutput(questions, drafts, "answered")).toEqual({
      outcome: "answered",
      answers: [{ question: "Which seat?", header: "Seat", selected: ["Aisle"] }],
    });
  });

  it("returns no answers when everything was skipped", () => {
    const questions = [question(), SEAT];

    expect(
      buildAskUserOutput(questions, [draft(), draft()], "answered").answers,
    ).toEqual([]);
  });

  it("reports no answers when the user dismissed the question", () => {
    // Partial drafts must not leak as if the user had submitted them.
    const drafts = [draft(["Nonstop"], "half-typed thought")];

    expect(buildAskUserOutput([question()], drafts, "dismissed")).toEqual({
      outcome: "dismissed",
      answers: [],
    });
  });
});

import { describe, expect, it } from "vitest";
import {
  progressFromStepFinish,
  progressFromStepStart,
  toolNameToLabel,
} from "../progress";

describe("progress — toolNameToLabel", () => {
  it("maps known tool names to verb labels", () => {
    expect(toolNameToLabel("navigate")).toBe("Navigating");
    expect(toolNameToLabel("clickElement")).toBe("Clicking");
    expect(toolNameToLabel("delegate")).toBe("Delegating to subagent");
    expect(toolNameToLabel("executePython")).toBe("Running Python");
  });

  it("falls back to the raw name for unknown tools", () => {
    expect(toolNameToLabel("future_new_tool")).toBe("future_new_tool");
  });
});

describe("progress — progressFromStepStart", () => {
  it("returns just the label when args are empty", () => {
    expect(
      progressFromStepStart({ toolName: "screenshot", argsPreview: "" }),
    ).toEqual({ lastEvent: "Taking screenshot", currentUrl: null });
  });

  it("returns just the label when args are malformed JSON", () => {
    expect(
      progressFromStepStart({ toolName: "navigate", argsPreview: "{borked" }),
    ).toEqual({ lastEvent: "Navigating", currentUrl: null });
  });

  it("falls back gracefully when truncated args can't be parsed", () => {
    // The runner middle-truncates argsPreview at 200 chars; this
    // simulates the case where the truncation sliced through the
    // middle of a JSON value and the result is unparseable.
    expect(
      progressFromStepStart({
        toolName: "navigate",
        argsPreview: '{"url":"https://example.com/very-l',
      }),
    ).toEqual({ lastEvent: "Navigating", currentUrl: null });
  });

  it("extracts URL host for navigate-style tools and surfaces currentUrl", () => {
    expect(
      progressFromStepStart({
        toolName: "navigate",
        argsPreview: '{"url":"https://example.com/path"}',
      }),
    ).toEqual({
      lastEvent: "Navigating to example.com",
      currentUrl: "https://example.com/path",
    });
  });

  it("supports targetUrl and href aliases", () => {
    expect(
      progressFromStepStart({
        toolName: "open_url",
        argsPreview: '{"targetUrl":"https://foo.bar/x"}',
      }).currentUrl,
    ).toBe("https://foo.bar/x");
    expect(
      progressFromStepStart({
        toolName: "navigate",
        argsPreview: '{"href":"https://baz.qux/"}',
      }).currentUrl,
    ).toBe("https://baz.qux/");
  });

  it("extracts URL from a nested tab object (defensive fallback)", () => {
    // Real selectTab args are `{tab: "t1"}` (a bare handle string).
    // This test documents the defensive fallback for any future tool
    // whose args nest a URL under `tab.url`.
    expect(
      progressFromStepStart({
        toolName: "selectTab",
        argsPreview: '{"tab":{"url":"https://example.com/x"}}',
      }),
    ).toEqual({
      lastEvent: "Switching tab to example.com",
      currentUrl: "https://example.com/x",
    });
  });

  it("clickElement: quotes the target ref", () => {
    // Real clickElement schema: `target` is the @ref or CSS selector.
    expect(
      progressFromStepStart({
        toolName: "clickElement",
        argsPreview: '{"tab":"t1","target":"@e3"}',
      }),
    ).toEqual({
      lastEvent: "Clicking ‘@e3’",
      currentUrl: null,
    });
  });

  it("clickElement: also accepts a raw CSS selector as `target`", () => {
    expect(
      progressFromStepStart({
        toolName: "clickElement",
        argsPreview: '{"tab":"t1","target":".btn-primary"}',
      }).lastEvent,
    ).toBe("Clicking ‘.btn-primary’");
  });

  it("clickElement: accepts legacy `selector` / `selectorOrText` shapes", () => {
    // Defensive fallbacks in case future SDK renames re-use these
    // historical keys.
    expect(
      progressFromStepStart({
        toolName: "clickElement",
        argsPreview: '{"selector":".old-shape"}',
      }).lastEvent,
    ).toBe("Clicking ‘.old-shape’");
    expect(
      progressFromStepStart({
        toolName: "clickElement",
        argsPreview: '{"selectorOrText":"Submit form"}',
      }).lastEvent,
    ).toBe("Clicking ‘Submit form’");
  });

  it("clickElement: truncates long targets", () => {
    expect(
      progressFromStepStart({
        toolName: "clickElement",
        argsPreview: `{"target":"${"x".repeat(60)}"}`,
      }).lastEvent,
    ).toBe(`Clicking ‘${"x".repeat(23)}…’`);
  });

  it("typeInElement: prefers `text` (human-readable) over `target` (ref)", () => {
    expect(
      progressFromStepStart({
        toolName: "typeInElement",
        argsPreview: '{"tab":"t1","target":"@e5","text":"hello world"}',
      }).lastEvent,
    ).toBe("Typing ‘hello world’");
  });

  it("pressKey: quotes the key", () => {
    expect(
      progressFromStepStart({
        toolName: "pressKey",
        argsPreview: '{"tab":"t1","key":"Enter"}',
      }).lastEvent,
    ).toBe("Pressing key ‘Enter’");
  });

  it("delegate: quotes the subagent slug", () => {
    expect(
      progressFromStepStart({
        toolName: "delegate",
        argsPreview: '{"slug":"researcher","task":"look up X"}',
      }).lastEvent,
    ).toBe("Delegating to subagent ‘researcher’");
  });

  it("Write/Edit: surface `file_path` (real SDK arg key)", () => {
    expect(
      progressFromStepStart({
        toolName: "Write",
        argsPreview: '{"file_path":"/spaces/a/notes.md","content":"…"}',
      }).lastEvent,
    ).toBe("Writing file /spaces/a/notes.md");
    expect(
      progressFromStepStart({
        toolName: "Edit",
        argsPreview: '{"file_path":"/foo/bar.ts","oldString":"a","newString":"b"}',
      }).lastEvent,
    ).toBe("Editing file /foo/bar.ts");
  });

  it("Delete: surfaces `path` (Delete's real key)", () => {
    expect(
      progressFromStepStart({
        toolName: "Delete",
        argsPreview: '{"path":"/tmp/x.txt"}',
      }).lastEvent,
    ).toBe("Deleting file /tmp/x.txt");
  });

  it("Write/Edit: also accept a bare `path` field defensively", () => {
    expect(
      progressFromStepStart({
        toolName: "Write",
        argsPreview: '{"path":"/legacy-shape.md"}',
      }).lastEvent,
    ).toBe("Writing file /legacy-shape.md");
  });

  it("unknown tools without recognisable args just show the tool name", () => {
    expect(
      progressFromStepStart({
        toolName: "future_new_tool",
        argsPreview: '{"unknown":"shape"}',
      }),
    ).toEqual({ lastEvent: "future_new_tool", currentUrl: null });
  });

  it("invalid URL in args yields no currentUrl and no host hint", () => {
    // If args carry a garbage string in a URL-shaped field, we must
    // NOT propagate it to the UI — the Activity card would render
    // literal garbage as a link.
    expect(
      progressFromStepStart({
        toolName: "navigate",
        argsPreview: '{"url":"not a url"}',
      }),
    ).toEqual({
      lastEvent: "Navigating",
      currentUrl: null,
    });
  });
});

describe("progress — progressFromStepFinish", () => {
  it("returns '<label> — done' for known tools", () => {
    expect(progressFromStepFinish({ toolName: "navigate" }).lastEvent).toBe(
      "Navigating — done",
    );
    expect(progressFromStepFinish({ toolName: "screenshot" }).lastEvent).toBe(
      "Taking screenshot — done",
    );
  });

  it("falls back to '<rawName> — done' for unknown tools", () => {
    expect(progressFromStepFinish({ toolName: "future_tool" }).lastEvent).toBe(
      "future_tool — done",
    );
  });
});

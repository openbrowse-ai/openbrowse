import { describe, expect, it } from "vitest";
import type { JSONContent } from "@tiptap/core";
import {
  extractSlashCommands,
  stripSlashCommandNodes,
} from "../slash-command-extract";

/** Helper: a paragraph doc with the given inline children. */
function doc(...inline: JSONContent[]): JSONContent {
  return {
    type: "doc",
    content: [{ type: "paragraph", content: inline }],
  };
}

const text = (t: string): JSONContent => ({ type: "text", text: t });
const compactNode = (): JSONContent => ({
  type: "skillSlash",
  attrs: { id: "compact", label: "compact", name: "compact" },
});
const skillNode = (name: string): JSONContent => ({
  type: "skillSlash",
  attrs: { id: name, label: name, name },
});
const tabMention = (): JSONContent => ({
  type: "tabMention",
  attrs: { title: "Tab", url: "https://x.test", favicon: "" },
});

describe("extractSlashCommands", () => {
  it("detects a built-in command node", () => {
    expect(extractSlashCommands(doc(compactNode()))).toEqual(["compact"]);
  });

  it("ignores skill slash nodes that are not built-in commands", () => {
    expect(extractSlashCommands(doc(skillNode("my-skill")))).toEqual([]);
  });

  it("ignores tab mentions and plain text", () => {
    expect(
      extractSlashCommands(doc(text("hello "), tabMention(), text(" world"))),
    ).toEqual([]);
  });

  it("detects a command mixed with surrounding text", () => {
    expect(
      extractSlashCommands(doc(compactNode(), text(" then do the thing"))),
    ).toEqual(["compact"]);
  });

  it("returns empty for an empty doc", () => {
    expect(extractSlashCommands({ type: "doc", content: [] })).toEqual([]);
  });
});

describe("stripSlashCommandNodes", () => {
  it("removes built-in command nodes and reports remaining text presence", () => {
    const result = stripSlashCommandNodes(
      doc(compactNode(), text(" then do the thing")),
    );
    expect(result.hasRemaining).toBe(true);
    // The command node is gone; text survives.
    const inline = result.json.content?.[0]?.content ?? [];
    expect(inline.some((n) => n.type === "skillSlash")).toBe(false);
    expect(inline.some((n) => n.type === "text")).toBe(true);
  });

  it("reports no remaining content when only the command is present", () => {
    const result = stripSlashCommandNodes(doc(compactNode()));
    expect(result.hasRemaining).toBe(false);
  });

  it("treats whitespace-only remainder as no remaining content", () => {
    const result = stripSlashCommandNodes(doc(compactNode(), text("   ")));
    expect(result.hasRemaining).toBe(false);
  });

  it("keeps non-command skill nodes as remaining content", () => {
    const result = stripSlashCommandNodes(
      doc(compactNode(), text(" "), skillNode("my-skill")),
    );
    expect(result.hasRemaining).toBe(true);
    const inline = result.json.content?.[0]?.content ?? [];
    expect(inline.some((n) => n.attrs?.name === "my-skill")).toBe(true);
    expect(inline.some((n) => n.attrs?.name === "compact")).toBe(false);
  });

  it("treats tab mentions as remaining content", () => {
    const result = stripSlashCommandNodes(doc(compactNode(), tabMention()));
    expect(result.hasRemaining).toBe(true);
  });

  it("leaves docs without commands untouched", () => {
    const input = doc(text("just text"));
    const result = stripSlashCommandNodes(input);
    expect(result.hasRemaining).toBe(true);
    expect(extractSlashCommands(result.json)).toEqual([]);
  });
});

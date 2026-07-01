import { describe, expect, it } from "vitest";
import { buildGroupTitle, type GroupTitleInputs } from "../group-title";

/**
 * Pure tests for the unified tab-group title builder. Used by both
 * the placeholder code in `bindTabsToConversation` and the LLM
 * labeler in `group-label.ts` so MCP-originated groups, subagent
 * groups, and user groups get consistently-shaped titles.
 *
 * Shape:
 *   - User chat:   "OB | <chat-title>"
 *   - Subagent:    "OB | <parent> · <slug>"  (or just "OB | <parent>" if slug blank)
 *   - MCP task:    "OB | MCP · <chat-title>"
 *
 * Chrome's tab-group title display is narrow; the builder slices each
 * dynamic segment to keep the final string short enough to render.
 */

describe("group-title — buildGroupTitle", () => {
  describe("user (source=user or undefined)", () => {
    it("returns 'OB | <title>'", () => {
      expect(
        buildGroupTitle({ source: "user", title: "My Chat", labelLength: 20 }),
      ).toBe("OB | My Chat");
    });

    it("treats undefined source as user", () => {
      expect(
        buildGroupTitle({ source: undefined, title: "x", labelLength: 20 }),
      ).toBe("OB | x");
    });

    it("trims title to labelLength chars", () => {
      const long = "a".repeat(50);
      expect(
        buildGroupTitle({ source: "user", title: long, labelLength: 10 }),
      ).toBe(`OB | ${"a".repeat(10)}`);
    });

    it("falls back to 'Chat' for empty/whitespace title", () => {
      expect(buildGroupTitle({ source: "user", title: "", labelLength: 20 })).toBe(
        "OB | Chat",
      );
      expect(buildGroupTitle({ source: "user", title: "   ", labelLength: 20 })).toBe(
        "OB | Chat",
      );
    });
  });

  describe("subagent (source=subagent OR parentTitle present)", () => {
    it("returns 'OB | <parent> · <slug>' when both are present", () => {
      expect(
        buildGroupTitle({
          source: "subagent",
          title: "ignored",
          parentTitle: "Plan Doc",
          subagentSlug: "researcher",
          labelLength: 20,
        }),
      ).toBe("OB | Plan Doc · researcher");
    });

    it("returns 'OB | <parent>' when slug is blank", () => {
      expect(
        buildGroupTitle({
          source: "subagent",
          title: "ignored",
          parentTitle: "Plan Doc",
          subagentSlug: "",
          labelLength: 20,
        }),
      ).toBe("OB | Plan Doc");
    });

    it("returns 'OB | <parent>' when slug is whitespace-only (no trailing ' · ')", () => {
      expect(
        buildGroupTitle({
          source: "subagent",
          title: "ignored",
          parentTitle: "Plan Doc",
          subagentSlug: "   ",
          labelLength: 20,
        }),
      ).toBe("OB | Plan Doc");
    });

    it("trims parent + slug to 16 chars each", () => {
      const long = "x".repeat(50);
      expect(
        buildGroupTitle({
          source: "subagent",
          title: "ignored",
          parentTitle: long,
          subagentSlug: long,
          labelLength: 20,
        }),
      ).toBe(`OB | ${"x".repeat(16)} · ${"x".repeat(16)}`);
    });

    it("'Chat' fallback when parent title is empty", () => {
      expect(
        buildGroupTitle({
          source: "subagent",
          title: "ignored",
          parentTitle: "",
          subagentSlug: "slug",
          labelLength: 20,
        }),
      ).toBe("OB | Chat · slug");
    });
  });

  describe("mcp (source=mcp)", () => {
    it("returns 'OB | MCP · <title>'", () => {
      expect(
        buildGroupTitle({
          source: "mcp",
          title: "Find YC startups",
          labelLength: 14,
        }),
      ).toBe("OB | MCP · Find YC startu");
    });

    it("trims title to labelLength chars to leave room for 'MCP · ' segment", () => {
      const long = "y".repeat(50);
      expect(
        buildGroupTitle({ source: "mcp", title: long, labelLength: 14 }),
      ).toBe(`OB | MCP · ${"y".repeat(14)}`);
    });

    it("'Chat' fallback when title is empty", () => {
      expect(
        buildGroupTitle({ source: "mcp", title: "", labelLength: 14 }),
      ).toBe("OB | MCP · Chat");
    });

    it("subagent under MCP: 'OB | MCP · <parent>' (slug dropped — too narrow)", () => {
      // Edge case: a subagent of an MCP run. We prioritise the MCP
      // tag over the subagent slug because users need to know "this
      // group was created by an external host" first.
      expect(
        buildGroupTitle({
          source: "mcp",
          title: "ignored",
          parentTitle: "Parent MCP",
          subagentSlug: "researcher",
          labelLength: 14,
        }),
      ).toBe("OB | MCP · Parent MCP");
    });

    it("strips a leading 'MCP:' from the title to avoid 'OB | MCP · MCP:…' (B12)", () => {
      expect(
        buildGroupTitle({
          source: "mcp",
          title: "MCP: do the thing",
          labelLength: 14,
        }),
      ).toBe("OB | MCP · do the thing");
    });

    it("strips a leading 'MCP ' (no colon) from the title", () => {
      expect(
        buildGroupTitle({
          source: "mcp",
          title: "MCP do the thing",
          labelLength: 14,
        }),
      ).toBe("OB | MCP · do the thing");
    });

    it("case-insensitive strip: 'mcp:' is handled too", () => {
      expect(
        buildGroupTitle({
          source: "mcp",
          title: "mcp: foo",
          labelLength: 14,
        }),
      ).toBe("OB | MCP · foo");
    });

    it("does not strip MCP from the middle of a title", () => {
      expect(
        buildGroupTitle({
          source: "mcp",
          title: "do MCP things",
          labelLength: 14,
        }),
      ).toBe("OB | MCP · do MCP things");
    });
  });
});

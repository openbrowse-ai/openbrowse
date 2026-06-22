import { describe, expect, it, vi, beforeEach } from "vitest";

const resolveMcpToolDisplay = vi.fn();
vi.mock("@/components/chat/mcp-tool-display", () => ({
  resolveMcpToolDisplay: (...args: unknown[]) => resolveMcpToolDisplay(...args),
}));

import { scanToolUsage, mergeDistinct, type ToolCallLike } from "../tool-usage";

beforeEach(() => {
  resolveMcpToolDisplay.mockReset();
  resolveMcpToolDisplay.mockReturnValue({ mcpInfo: null });
});

describe("scanToolUsage", () => {
  it("returns empty for no tool calls", () => {
    expect(scanToolUsage([], null)).toEqual({
      connectorIds: [],
      skillNames: [],
      spaceFiles: [],
    });
    expect(resolveMcpToolDisplay).not.toHaveBeenCalled();
  });

  it("does not resolve non-mcp, non-skill tools", () => {
    const calls: ToolCallLike[] = [{ toolName: "navigate" }];
    expect(scanToolUsage(calls, null)).toEqual({
      connectorIds: [],
      skillNames: [],
      spaceFiles: [],
    });
    expect(resolveMcpToolDisplay).not.toHaveBeenCalled();
  });

  it("maps mcp_ tools to connector ids", () => {
    resolveMcpToolDisplay.mockImplementation((name: string) =>
      name.startsWith("mcp_slack_")
        ? { mcpInfo: { connector: { id: "slack", name: "Slack" }, toolName: "x" } }
        : { mcpInfo: null },
    );
    const calls: ToolCallLike[] = [
      { toolName: "mcp_slack_send" },
      { toolName: "mcp_slack_list" },
    ];
    // scanToolUsage does NOT dedupe — both contribute
    expect(scanToolUsage(calls, null)).toEqual({
      connectorIds: ["slack", "slack"],
      skillNames: [],
      spaceFiles: [],
    });
  });

  it("skips unmatched mcp servers (no connector)", () => {
    resolveMcpToolDisplay.mockReturnValue({ mcpInfo: null });
    const calls: ToolCallLike[] = [{ toolName: "mcp_uuid_create" }];
    expect(scanToolUsage(calls, null)).toEqual({
      connectorIds: [],
      skillNames: [],
      spaceFiles: [],
    });
  });

  it("collects non-empty string skill names", () => {
    const calls: ToolCallLike[] = [
      { toolName: "skill", input: { name: "schedule" } },
      { toolName: "skill", input: { name: "brainstorming" } },
    ];
    expect(scanToolUsage(calls, null)).toEqual({
      connectorIds: [],
      skillNames: ["schedule", "brainstorming"],
      spaceFiles: [],
    });
  });

  it("ignores skill calls with missing/non-string name", () => {
    const calls: ToolCallLike[] = [
      { toolName: "skill", input: {} },
      { toolName: "skill", input: { name: 123 } },
      { toolName: "skill" },
    ];
    expect(scanToolUsage(calls, null)).toEqual({
      connectorIds: [],
      skillNames: [],
      spaceFiles: [],
    });
  });

  describe("space-file references", () => {
    const SPACE = "abc123";

    it("returns no space files when spaceId is null", () => {
      const calls: ToolCallLike[] = [
        {
          toolName: "Write",
          input: { file_path: "spaces/abc123/workspace/poem.md", content: "x" },
        },
      ];
      expect(scanToolUsage(calls, null)).toEqual({
        connectorIds: [],
        skillNames: [],
        spaceFiles: [],
      });
    });

    it("extracts the relative path for Read/Write/Edit on the active space", () => {
      const calls: ToolCallLike[] = [
        { toolName: "Read", input: { file_path: "spaces/abc123/workspace/notes.md" } },
        { toolName: "Write", input: { file_path: "spaces/abc123/workspace/poem.md", content: "x" } },
        {
          toolName: "Edit",
          input: {
            file_path: "spaces/abc123/workspace/sub/data.csv",
            oldString: "a",
            newString: "b",
          },
        },
      ];
      expect(scanToolUsage(calls, SPACE)).toEqual({
        connectorIds: [],
        skillNames: [],
        spaceFiles: ["notes.md", "poem.md", "sub/data.csv"],
      });
    });

    it("strips a leading slash before matching", () => {
      const calls: ToolCallLike[] = [
        { toolName: "Read", input: { file_path: "/spaces/abc123/workspace/poem.md" } },
      ];
      expect(scanToolUsage(calls, SPACE).spaceFiles).toEqual(["poem.md"]);
    });

    it("ignores cross-space paths (different spaceId)", () => {
      const calls: ToolCallLike[] = [
        { toolName: "Read", input: { file_path: "spaces/other-space/workspace/x.md" } },
      ];
      expect(scanToolUsage(calls, SPACE).spaceFiles).toEqual([]);
    });

    it("ignores conversation-workspace paths", () => {
      const calls: ToolCallLike[] = [
        { toolName: "Write", input: { file_path: "draft.md", content: "x" } },
        { toolName: "Read", input: { file_path: "subdir/data.csv" } },
      ];
      expect(scanToolUsage(calls, SPACE).spaceFiles).toEqual([]);
    });

    it("skips the bare workspace root (it is a directory)", () => {
      const calls: ToolCallLike[] = [
        { toolName: "Read", input: { file_path: "spaces/abc123/workspace" } },
        { toolName: "Read", input: { file_path: "spaces/abc123/workspace/" } },
      ];
      expect(scanToolUsage(calls, SPACE).spaceFiles).toEqual([]);
    });

    it("does not dedupe — repeats are emitted (mergeDistinct dedupes downstream)", () => {
      const calls: ToolCallLike[] = [
        { toolName: "Read", input: { file_path: "spaces/abc123/workspace/poem.md" } },
        { toolName: "Edit", input: { file_path: "spaces/abc123/workspace/poem.md", oldString: "a", newString: "b" } },
      ];
      expect(scanToolUsage(calls, SPACE).spaceFiles).toEqual(["poem.md", "poem.md"]);
    });

    it("ignores non-fs tools and tools with missing/non-string file_path", () => {
      const calls: ToolCallLike[] = [
        { toolName: "Glob", input: { pattern: "spaces/abc123/workspace/*.md" } },
        { toolName: "Read", input: {} },
        { toolName: "Read", input: { file_path: 123 } },
        { toolName: "Read" },
      ];
      expect(scanToolUsage(calls, SPACE).spaceFiles).toEqual([]);
    });
  });
});

describe("mergeDistinct", () => {
  it("appends new items preserving first-seen order", () => {
    expect(mergeDistinct(["a"], ["b", "c"])).toEqual(["a", "b", "c"]);
  });

  it("dedupes against existing and within incoming", () => {
    expect(mergeDistinct(["a"], ["a", "b", "b"])).toEqual(["a", "b"]);
  });

  it("returns null when nothing new is added", () => {
    expect(mergeDistinct(["a", "b"], ["a"])).toBeNull();
    expect(mergeDistinct(["a"], [])).toBeNull();
  });

  it("treats undefined existing as empty", () => {
    expect(mergeDistinct(undefined, ["x"])).toEqual(["x"]);
    expect(mergeDistinct(undefined, [])).toBeNull();
  });
});

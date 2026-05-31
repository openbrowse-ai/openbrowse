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
    expect(scanToolUsage([])).toEqual({ connectorIds: [], skillNames: [] });
    expect(resolveMcpToolDisplay).not.toHaveBeenCalled();
  });

  it("does not resolve non-mcp, non-skill tools", () => {
    const calls: ToolCallLike[] = [{ toolName: "navigate" }];
    expect(scanToolUsage(calls)).toEqual({ connectorIds: [], skillNames: [] });
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
    expect(scanToolUsage(calls)).toEqual({
      connectorIds: ["slack", "slack"],
      skillNames: [],
    });
  });

  it("skips unmatched mcp servers (no connector)", () => {
    resolveMcpToolDisplay.mockReturnValue({ mcpInfo: null });
    const calls: ToolCallLike[] = [{ toolName: "mcp_uuid_create" }];
    expect(scanToolUsage(calls)).toEqual({ connectorIds: [], skillNames: [] });
  });

  it("collects non-empty string skill names", () => {
    const calls: ToolCallLike[] = [
      { toolName: "skill", input: { name: "schedule" } },
      { toolName: "skill", input: { name: "brainstorming" } },
    ];
    expect(scanToolUsage(calls)).toEqual({
      connectorIds: [],
      skillNames: ["schedule", "brainstorming"],
    });
  });

  it("ignores skill calls with missing/non-string name", () => {
    const calls: ToolCallLike[] = [
      { toolName: "skill", input: {} },
      { toolName: "skill", input: { name: 123 } },
      { toolName: "skill" },
    ];
    expect(scanToolUsage(calls)).toEqual({ connectorIds: [], skillNames: [] });
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

import { describe, expect, it, vi, beforeEach } from "vitest";

// resolveMcpToolDisplay is the connector resolver; mock it so the derive
// logic is tested independently of the live MCP registry / connector catalog.
const resolveMcpToolDisplay = vi.fn();
vi.mock("@/components/chat/mcp-tool-display", () => ({
  resolveMcpToolDisplay: (...args: unknown[]) => resolveMcpToolDisplay(...args),
}));

import {
  deriveUsedConnectors,
  deriveLoadedSkills,
  type DerivedConnector,
} from "../context-derive";
import type { SerializedUIPart } from "@/lib/agent/message-types";

function toolPart(
  toolName: string,
  input?: unknown,
  state = "output-available",
): SerializedUIPart {
  return {
    type: "dynamic-tool",
    toolName,
    toolCallId: `id-${toolName}-${Math.random()}`,
    state,
    input,
  };
}

beforeEach(() => {
  resolveMcpToolDisplay.mockReset();
  resolveMcpToolDisplay.mockReturnValue({
    mcpInfo: null,
    readableName: null,
    readableNameSentence: null,
  });
});

describe("deriveUsedConnectors", () => {
  it("returns empty when there are no mcp_ tool parts", () => {
    const parts: SerializedUIPart[] = [
      { type: "text", text: "hi" },
      toolPart("navigate"),
    ];
    expect(deriveUsedConnectors(parts)).toEqual([]);
    // non-mcp tools are not resolved
    expect(resolveMcpToolDisplay).not.toHaveBeenCalled();
  });

  it("maps mcp_ tools to connectors and dedupes by connector id", () => {
    resolveMcpToolDisplay.mockImplementation((name: string) => {
      if (name.startsWith("mcp_slack_")) {
        return { mcpInfo: { connector: { id: "slack", name: "Slack" }, toolName: "x" } };
      }
      return { mcpInfo: null };
    });
    const parts: SerializedUIPart[] = [
      toolPart("mcp_slack_send_message"),
      toolPart("mcp_slack_list_channels"),
    ];
    const out = deriveUsedConnectors(parts);
    expect(out).toEqual<DerivedConnector[]>([{ id: "slack", name: "Slack" }]);
  });

  it("skips unmatched MCP servers (no connector) in v1", () => {
    resolveMcpToolDisplay.mockReturnValue({ mcpInfo: null });
    const parts: SerializedUIPart[] = [
      toolPart("mcp_589509c2-uuid_create-record"),
    ];
    expect(deriveUsedConnectors(parts)).toEqual([]);
  });

  it("counts an errored mcp_ call (state-agnostic): output-error still surfaces the connector", () => {
    resolveMcpToolDisplay.mockReturnValue({
      mcpInfo: { connector: { id: "slack", name: "Slack" }, toolName: "x" },
    });
    const parts: SerializedUIPart[] = [
      toolPart("mcp_slack_send_message", undefined, "output-error"),
    ];
    expect(deriveUsedConnectors(parts)).toEqual<DerivedConnector[]>([
      { id: "slack", name: "Slack" },
    ]);
  });
});

describe("deriveLoadedSkills", () => {
  it("collects skill names from skill tool parts, deduped, order-stable", () => {
    const parts: SerializedUIPart[] = [
      toolPart("skill", { name: "schedule" }),
      toolPart("navigate"),
      toolPart("skill", { name: "schedule" }),
      toolPart("skill", { name: "brainstorming" }),
    ];
    expect(deriveLoadedSkills(parts)).toEqual(["schedule", "brainstorming"]);
  });

  it("ignores skill parts with non-string or missing name", () => {
    const parts: SerializedUIPart[] = [
      toolPart("skill", {}),
      toolPart("skill", { name: 123 }),
      toolPart("skill", undefined),
    ];
    expect(deriveLoadedSkills(parts)).toEqual([]);
  });

  it("returns empty when there are no skill tool parts", () => {
    expect(deriveLoadedSkills([{ type: "text", text: "x" }])).toEqual([]);
  });

  it("counts an in-flight skill call (state-agnostic): input-streaming still surfaces the skill", () => {
    const parts: SerializedUIPart[] = [
      toolPart("skill", { name: "schedule" }, "input-streaming"),
    ];
    expect(deriveLoadedSkills(parts)).toEqual(["schedule"]);
  });
});

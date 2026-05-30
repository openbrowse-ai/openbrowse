import { describe, expect, it, vi, beforeEach } from "vitest";

// Mocked deps — the helper resolves the connector + server URL through
// these. We control both so the test is deterministic and doesn't depend
// on the live MCP registry or the real connector catalog.
const getStates = vi.fn();
vi.mock("@/lib/mcp", () => ({
  getMcpRegistry: () => ({ getStates }),
}));

const getConnectorForMcpTool = vi.fn();
vi.mock("@openbrowse/connectors", () => ({
  getConnectorForMcpTool: (...args: unknown[]) =>
    getConnectorForMcpTool(...args),
}));

import {
  resolveMcpToolDisplay,
  parseMcpToolName,
} from "../mcp-tool-display";

beforeEach(() => {
  getStates.mockReset();
  getConnectorForMcpTool.mockReset();
  getStates.mockReturnValue([]);
  getConnectorForMcpTool.mockReturnValue(null);
});

describe("parseMcpToolName", () => {
  it("extracts and normalizes the tool name from an MCP key", () => {
    expect(parseMcpToolName("mcp_589509c2-85fb-429b-988a-9d8a21401201_create-record")).toBe(
      "create record",
    );
    expect(parseMcpToolName("mcp_attio_list_records")).toBe("list records");
  });

  it("returns null for non-MCP tool names", () => {
    expect(parseMcpToolName("navigate")).toBeNull();
    expect(parseMcpToolName("executeOnPage")).toBeNull();
  });
});

describe("resolveMcpToolDisplay", () => {
  it("unmatched MCP server (UUID id, no connector) → readable name, no icon", () => {
    // The exact case from the screenshot: a generic MCP server whose id
    // is a UUID and doesn't map to a known connector.
    const out = resolveMcpToolDisplay(
      "mcp_589509c2-85fb-429b-988a-9d8a21401201_create-record",
    );
    expect(out.mcpInfo).toBeNull();
    expect(out.readableName).toBe("create record");
    expect(out.readableNameSentence).toBe("Create record");
  });

  it("connector-matched MCP tool → connector + sentence-cased name", () => {
    const connector = { id: "attio", name: "Attio" };
    getConnectorForMcpTool.mockReturnValue({
      connector,
      toolName: "create-record",
    });
    const out = resolveMcpToolDisplay("mcp_attio_create-record");
    expect(out.mcpInfo?.connector).toBe(connector);
    expect(out.readableName).toBe("create record");
    expect(out.readableNameSentence).toBe("Create record");
  });

  it("threads the resolved server URL into getConnectorForMcpTool", () => {
    getStates.mockReturnValue([
      { config: { id: "589509c2", url: "https://mcp.example.com" } },
    ]);
    resolveMcpToolDisplay("mcp_589509c2_create-record");
    expect(getConnectorForMcpTool).toHaveBeenCalledWith(
      "mcp_589509c2_create-record",
      "https://mcp.example.com",
    );
  });

  it("non-MCP built-in tool → all readable fields null", () => {
    const out = resolveMcpToolDisplay("navigate");
    expect(out.mcpInfo).toBeNull();
    expect(out.readableName).toBeNull();
    expect(out.readableNameSentence).toBeNull();
  });
});

import { describe, expect, it } from "vitest";
import {
  AGENT_RUN,
  AGENT_RUN_PORT_PREFIX,
  isAgentRunApprovePayload,
  isAgentRunChunkPayload,
  isAgentRunStartPayload,
  isAgentRunStopPayload,
  parseAgentRunPortName,
  type AgentRunChunkPayload,
  type AgentRunStartPayload,
} from "../messages";

/**
 * The agent-host wire-shape constants and runtime type-guards must match
 * the format the renderer and SW agree on. Adding type guards (rather
 * than trusting types at runtime IPC boundaries) defends against
 * malformed third-party messages and ensures the port router can route
 * by payload type safely.
 */

describe("agent-host messages", () => {
  it("exposes the AGENT_RUN constant set", () => {
    expect(AGENT_RUN.START).toBe("AGENT_RUN_START");
    expect(AGENT_RUN.STOP).toBe("AGENT_RUN_STOP");
    expect(AGENT_RUN.APPROVE).toBe("AGENT_RUN_APPROVE");
    expect(AGENT_RUN.REGEN).toBe("AGENT_RUN_REGEN");
    expect(AGENT_RUN.ACK).toBe("AGENT_RUN_ACK");
    expect(AGENT_RUN.CHUNK).toBe("AGENT_RUN_CHUNK");
    expect(AGENT_RUN.DONE).toBe("AGENT_RUN_DONE");
    expect(AGENT_RUN.ERROR).toBe("AGENT_RUN_ERROR");
  });

  describe("isAgentRunStartPayload", () => {
    it("accepts a well-formed start payload", () => {
      const payload: AgentRunStartPayload = {
        type: AGENT_RUN.START,
        conversationId: "conv-A",
        messages: [],
        origin: "sidepanel",
      };
      expect(isAgentRunStartPayload(payload)).toBe(true);
    });

    it("accepts origin='mcp' (MCP bridge phase 2)", () => {
      // The MCP task runner stamps `origin: "mcp"` on every run it
      // initiates so diagnostics can tell server-driven runs from
      // user-driven ones. The guard accepts any string under `origin`;
      // this case is purely to lock in the type-level union.
      const payload: AgentRunStartPayload = {
        type: AGENT_RUN.START,
        conversationId: "conv-mcp-1",
        messages: [],
        origin: "mcp",
      };
      expect(isAgentRunStartPayload(payload)).toBe(true);
    });

    it("rejects messages of a different type", () => {
      expect(
        isAgentRunStartPayload({
          type: AGENT_RUN.STOP,
          conversationId: "conv-A",
        }),
      ).toBe(false);
    });

    it("rejects messages missing conversationId", () => {
      expect(isAgentRunStartPayload({ type: AGENT_RUN.START })).toBe(false);
    });

    it("rejects messages missing the messages array", () => {
      // Defence-in-depth: every well-formed renderer call supplies a
      // (possibly empty) messages array. Reject malformed IPC at the
      // boundary so the SW host can rely on the type assertion past
      // the guard.
      expect(
        isAgentRunStartPayload({
          type: AGENT_RUN.START,
          conversationId: "conv-A",
          origin: "sidepanel",
        }),
      ).toBe(false);
    });

    it("rejects messages with a non-array `messages`", () => {
      expect(
        isAgentRunStartPayload({
          type: AGENT_RUN.START,
          conversationId: "conv-A",
          messages: "not-an-array",
          origin: "sidepanel",
        }),
      ).toBe(false);
    });

    it("rejects messages missing origin", () => {
      expect(
        isAgentRunStartPayload({
          type: AGENT_RUN.START,
          conversationId: "conv-A",
          messages: [],
        }),
      ).toBe(false);
    });

    it("rejects non-object inputs", () => {
      expect(isAgentRunStartPayload(null)).toBe(false);
      expect(isAgentRunStartPayload(undefined)).toBe(false);
      expect(isAgentRunStartPayload("AGENT_RUN_START")).toBe(false);
    });
  });

  describe("isAgentRunStopPayload", () => {
    it("accepts a well-formed stop payload", () => {
      expect(
        isAgentRunStopPayload({
          type: AGENT_RUN.STOP,
          conversationId: "conv-A",
        }),
      ).toBe(true);
    });

    it("rejects mismatched type", () => {
      expect(
        isAgentRunStopPayload({
          type: AGENT_RUN.START,
          conversationId: "conv-A",
        }),
      ).toBe(false);
    });
  });

  describe("isAgentRunApprovePayload", () => {
    it("accepts an approval payload with an approval object", () => {
      expect(
        isAgentRunApprovePayload({
          type: AGENT_RUN.APPROVE,
          conversationId: "conv-A",
          approval: { id: "tc-1", approved: true },
        }),
      ).toBe(true);
    });

    it("rejects approval missing the approval object", () => {
      expect(
        isAgentRunApprovePayload({
          type: AGENT_RUN.APPROVE,
          conversationId: "conv-A",
        }),
      ).toBe(false);
    });
  });

  describe("isAgentRunChunkPayload", () => {
    it("accepts a chunk payload with a chunk field", () => {
      const payload: AgentRunChunkPayload = {
        type: AGENT_RUN.CHUNK,
        conversationId: "conv-A",
        chunk: { type: "text-delta", text: "hello" } as unknown as AgentRunChunkPayload["chunk"],
      };
      expect(isAgentRunChunkPayload(payload)).toBe(true);
    });

    it("rejects chunks of the wrong type", () => {
      expect(
        isAgentRunChunkPayload({
          type: AGENT_RUN.DONE,
          conversationId: "conv-A",
        }),
      ).toBe(false);
    });
  });

  describe("parseAgentRunPortName", () => {
    it("extracts the conversationId from a valid port name", () => {
      expect(parseAgentRunPortName(`${AGENT_RUN_PORT_PREFIX}conv-abc`)).toBe(
        "conv-abc",
      );
    });

    it("returns null for a port name with an empty conversationId", () => {
      expect(parseAgentRunPortName(AGENT_RUN_PORT_PREFIX)).toBeNull();
    });

    it("returns null for a port name without the prefix", () => {
      expect(parseAgentRunPortName("sidepanel")).toBeNull();
      expect(parseAgentRunPortName("offscreen-lm:abc")).toBeNull();
    });

    it("handles conversationIds containing colons", () => {
      // Conversation ids in the codebase are mostly UUID-ish but the
      // protocol must tolerate any non-empty suffix.
      expect(
        parseAgentRunPortName(`${AGENT_RUN_PORT_PREFIX}task-conv-x:123`),
      ).toBe("task-conv-x:123");
    });
  });
});

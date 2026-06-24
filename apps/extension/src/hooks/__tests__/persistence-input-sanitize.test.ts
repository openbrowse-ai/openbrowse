import { describe, expect, it, vi } from "vitest";
import { serializeParts, deserializePart } from "../useAgentChat";
import type {
  AgentDataParts,
  SerializedToolPart,
  SerializedUIPart,
} from "@/lib/agent/message-types";
import type { UIMessage } from "ai";

type AgentMessageParts = UIMessage<unknown, AgentDataParts>["parts"];

/**
 * End-to-end coverage of the input-shape contract on the persistence
 * boundary. The contract:
 *   - serialize never writes a non-object `input` to chat-db. A
 *     stringified-JSON object is parsed; an irrecoverable non-object
 *     drops the entire tool part.
 *   - deserialize never re-introduces a non-object `input` into the
 *     live UIMessage list. A stringified-JSON object on disk is parsed;
 *     an irrecoverable non-object drops the part (null return).
 *
 * The two pillars together close the chat-db re-poisoning path that made
 * the Opus bug stick across reloads.
 */

describe("serializeParts — tool input sanitization", () => {
  it("preserves a plain-object input verbatim", () => {
    const parts: AgentMessageParts = [
      {
        type: "dynamic-tool",
        toolName: "navigate",
        toolCallId: "c1",
        state: "output-available",
        input: { url: "https://example.com" },
        output: { ok: true },
      } as never,
    ];
    const out = serializeParts(parts);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      type: "dynamic-tool",
      input: { url: "https://example.com" },
    });
  });

  it("recovers a stringified-JSON-object input", () => {
    const parts: AgentMessageParts = [
      {
        type: "dynamic-tool",
        toolName: "navigate",
        toolCallId: "c1",
        state: "output-available",
        input: '{"url":"https://example.com"}',
        output: { ok: true },
      } as never,
    ];
    const out = serializeParts(parts);
    expect(out).toHaveLength(1);
    expect((out[0] as SerializedToolPart).input).toEqual({
      url: "https://example.com",
    });
  });

  it("DROPS the part when input is '' (the Opus no-arg-tool quirk)", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const parts: AgentMessageParts = [
        {
          type: "dynamic-tool",
          toolName: "list-attribute-definitions",
          toolCallId: "c1",
          state: "output-error",
          errorText: "boom",
          input: "",
        } as never,
      ];
      const out = serializeParts(parts);
      expect(out).toHaveLength(0);
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("DROPS the part when input is null", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const parts: AgentMessageParts = [
        {
          type: "dynamic-tool",
          toolName: "x",
          toolCallId: "c1",
          state: "output-error",
          errorText: "boom",
          input: null,
        } as never,
      ];
      const out = serializeParts(parts);
      expect(out).toHaveLength(0);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("DROPS the part when input is an array", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const parts: AgentMessageParts = [
        {
          type: "dynamic-tool",
          toolName: "x",
          toolCallId: "c1",
          state: "output-error",
          errorText: "boom",
          input: [1, 2, 3],
        } as never,
      ];
      expect(serializeParts(parts)).toHaveLength(0);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("preserves a part whose input is intentionally absent (terminal state)", () => {
    // input:undefined is a legitimate persisted shape — the SDK skips
    // schema validation for output-error parts when input is undefined.
    // The transport's runtime normalizer decides at send time whether to
    // drop or coerce.
    const parts: AgentMessageParts = [
      {
        type: "dynamic-tool",
        toolName: "x",
        toolCallId: "c1",
        state: "output-error",
        errorText: "boom",
      } as never,
    ];
    const out = serializeParts(parts);
    expect(out).toHaveLength(1);
    expect((out[0] as SerializedToolPart).input).toBeUndefined();
  });

  it("recovers via rawInput when input is missing but rawInput is an object", () => {
    const parts: AgentMessageParts = [
      {
        type: "dynamic-tool",
        toolName: "navigate",
        toolCallId: "c1",
        state: "output-error",
        errorText: "boom",
        rawInput: { url: "https://example.com" },
      } as never,
    ];
    const out = serializeParts(parts);
    expect(out).toHaveLength(1);
    expect((out[0] as SerializedToolPart).input).toEqual({
      url: "https://example.com",
    });
  });

  it("applies the same sanitization to tool-<name> fallback parts (built-in tools)", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const parts: AgentMessageParts = [
        {
          type: "tool-navigate",
          toolCallId: "c1",
          state: "output-error",
          errorText: "boom",
          input: "", // malformed
        } as never,
      ];
      expect(serializeParts(parts)).toHaveLength(0);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("preserves a tool-<name> part with a valid object input", () => {
    const parts: AgentMessageParts = [
      {
        type: "tool-navigate",
        toolCallId: "c1",
        state: "output-available",
        input: { url: "https://example.com" },
        output: { ok: true },
      } as never,
    ];
    const out = serializeParts(parts);
    expect(out).toHaveLength(1);
    expect((out[0] as SerializedToolPart).input).toEqual({
      url: "https://example.com",
    });
  });

  it("preserves a tool-<name> part that has no input field (intentionally absent)", () => {
    // Pre-fix the fallback branch had `"input" in p` in its guard, so a
    // tool-<name> part without an input field was silently dropped at
    // serialize time. The dynamic-tool branch above had no such gate,
    // creating an asymmetry. Now both branches let absent-input parts
    // through to the sanitizer, which preserves them as input:undefined
    // (legitimate persisted shape for terminal states).
    const parts: AgentMessageParts = [
      {
        type: "tool-navigate",
        toolCallId: "c1",
        state: "output-error",
        errorText: "interrupted",
        // no input key
      } as never,
    ];
    const out = serializeParts(parts);
    expect(out).toHaveLength(1);
    expect((out[0] as SerializedToolPart).input).toBeUndefined();
    expect((out[0] as SerializedToolPart).errorText).toBe("interrupted");
  });
});

describe("deserializePart — tool input sanitization", () => {
  it("preserves a plain-object input verbatim", () => {
    const p: SerializedUIPart = {
      type: "dynamic-tool",
      toolName: "navigate",
      toolCallId: "c1",
      state: "output-available",
      input: { url: "https://example.com" },
      output: { ok: true },
    };
    const out = deserializePart(p);
    expect(out).not.toBeNull();
    expect((out as { input: unknown }).input).toEqual({
      url: "https://example.com",
    });
  });

  it("recovers a stringified-JSON-object input from a legacy chat-db row", () => {
    const p: SerializedUIPart = {
      type: "dynamic-tool",
      toolName: "navigate",
      toolCallId: "c1",
      state: "output-available",
      // Pre-fix chat-db row: input was persisted as a stringified blob.
      input: '{"url":"https://example.com"}' as never,
      output: { ok: true },
    };
    const out = deserializePart(p);
    expect(out).not.toBeNull();
    expect((out as { input: unknown }).input).toEqual({
      url: "https://example.com",
    });
  });

  it("DROPS a tool part whose input is `\"\"` (legacy Opus persistence)", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const p: SerializedUIPart = {
        type: "dynamic-tool",
        toolName: "list-attribute-definitions",
        toolCallId: "c1",
        state: "output-error",
        errorText: "boom",
        input: "" as never,
      };
      const out = deserializePart(p);
      expect(out).toBeNull();
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("DROPS a tool part whose input is `null`", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const p: SerializedUIPart = {
        type: "dynamic-tool",
        toolName: "x",
        toolCallId: "c1",
        state: "output-error",
        errorText: "boom",
        input: null as never,
      };
      expect(deserializePart(p)).toBeNull();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("preserves a part with intentionally-absent input (terminal state)", () => {
    const p: SerializedUIPart = {
      type: "dynamic-tool",
      toolName: "x",
      toolCallId: "c1",
      state: "output-error",
      errorText: "boom",
      // No `input` key — intentional absence.
    };
    const out = deserializePart(p);
    expect(out).not.toBeNull();
    expect((out as { input: unknown }).input).toBeUndefined();
  });

  it("recovers a legacy persisted part via rawInput when input is absent", () => {
    // Pre-fix serialize never wrote rawInput, but legacy IDB rows from
    // older code paths may carry it (IDB stores whole objects). The
    // deserializer threads rawInput through the normalizer so a row
    // like `{ input: undefined, rawInput: { url: "x" } }` recovers
    // cleanly instead of being treated as input-less.
    const p = {
      type: "dynamic-tool",
      toolName: "navigate",
      toolCallId: "c1",
      state: "output-error",
      errorText: "interrupted",
      rawInput: { url: "https://example.com" },
    } as unknown as SerializedUIPart;
    const out = deserializePart(p);
    expect(out).not.toBeNull();
    expect((out as { input: unknown }).input).toEqual({
      url: "https://example.com",
    });
  });

  it("recovers a legacy persisted part via stringified-JSON rawInput", () => {
    const p = {
      type: "dynamic-tool",
      toolName: "navigate",
      toolCallId: "c1",
      state: "output-error",
      errorText: "interrupted",
      rawInput: '{"url":"https://example.com"}',
    } as unknown as SerializedUIPart;
    const out = deserializePart(p);
    expect(out).not.toBeNull();
    expect((out as { input: unknown }).input).toEqual({
      url: "https://example.com",
    });
  });
});

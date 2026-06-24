import { describe, expect, it, vi } from "vitest";
import { assertModelMessageToolInputs } from "../compacting-transport";

/**
 * Tests for the last-mile assertion that runs after `convertToModelMessages`
 * and before `agent.stream(...)`. The assertion's contract:
 *   - Plain-object `input` on a tool-call: untouched.
 *   - Non-object `input`: in-place coercion to `{}` + console.error log.
 *   - Non-tool-call content: untouched.
 *
 * This is the "if the upstream layers all failed, we still don't 400 the
 * provider" backstop. It SHOULD never fire in production after Fix 1+2+3,
 * but if it does we get a self-diagnosing log line and the user's turn
 * still completes (matching Gemini's adapter behavior).
 */

type ModelMessage = {
  role: "user" | "assistant" | "system" | "tool";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  content: any;
};

describe("assertModelMessageToolInputs", () => {
  it("leaves a tool-call with an object input untouched", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const messages: ModelMessage[] = [
        {
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolName: "navigate",
              toolCallId: "c1",
              input: { url: "https://example.com" },
            },
          ],
        },
      ];
      assertModelMessageToolInputs(messages as never, "test");
      expect(messages[0].content[0].input).toEqual({
        url: "https://example.com",
      });
      expect(errSpy).not.toHaveBeenCalled();
    } finally {
      errSpy.mockRestore();
    }
  });

  it("coerces an empty-string input to {} and logs an error", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const messages: ModelMessage[] = [
        {
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolName: "list-attribute-definitions",
              toolCallId: "c1",
              input: "", // ← the Opus bug
            },
          ],
        },
      ];
      assertModelMessageToolInputs(messages as never, "test");
      expect(messages[0].content[0].input).toEqual({});
      expect(errSpy).toHaveBeenCalled();
      // The error log should mention the tool name and the typeof.
      const args = errSpy.mock.calls[0]
        .map((a) => (typeof a === "string" ? a : ""))
        .join(" ");
      expect(args).toContain("list-attribute-definitions");
      expect(args).toContain("typeof=string");
      expect(args).toContain("Coercing to {}");
    } finally {
      errSpy.mockRestore();
    }
  });

  it("coerces a null input to {}", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const messages: ModelMessage[] = [
        {
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolName: "x",
              toolCallId: "c1",
              input: null,
            },
          ],
        },
      ];
      assertModelMessageToolInputs(messages as never, "test");
      expect(messages[0].content[0].input).toEqual({});
      expect(errSpy).toHaveBeenCalled();
    } finally {
      errSpy.mockRestore();
    }
  });

  it("coerces an array input to {}", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const messages: ModelMessage[] = [
        {
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolName: "x",
              toolCallId: "c1",
              input: [1, 2, 3],
            },
          ],
        },
      ];
      assertModelMessageToolInputs(messages as never, "test");
      expect(messages[0].content[0].input).toEqual({});
      expect(errSpy).toHaveBeenCalled();
    } finally {
      errSpy.mockRestore();
    }
  });

  it("leaves non-tool-call content alone", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const messages: ModelMessage[] = [
        {
          role: "assistant",
          content: [
            { type: "text", text: "hi" },
            { type: "reasoning", text: "thinking" },
          ],
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "c1",
              toolName: "navigate",
              output: { ok: true },
            },
          ],
        },
      ];
      assertModelMessageToolInputs(messages as never, "test");
      expect(errSpy).not.toHaveBeenCalled();
      expect(messages[0].content[0]).toMatchObject({ type: "text" });
    } finally {
      errSpy.mockRestore();
    }
  });

  it("processes multiple offending blocks across multiple messages", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const messages: ModelMessage[] = [
        {
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolName: "a",
              toolCallId: "c1",
              input: "",
            },
            {
              type: "tool-call",
              toolName: "b",
              toolCallId: "c2",
              input: { ok: 1 },
            },
          ],
        },
        {
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolName: "c",
              toolCallId: "c3",
              input: 42,
            },
          ],
        },
      ];
      assertModelMessageToolInputs(messages as never, "test");
      expect(messages[0].content[0].input).toEqual({});
      expect(messages[0].content[1].input).toEqual({ ok: 1 });
      expect(messages[1].content[0].input).toEqual({});
      // 2 offending blocks → 2 error logs.
      expect(errSpy).toHaveBeenCalledTimes(2);
    } finally {
      errSpy.mockRestore();
    }
  });

  it("handles a string-content message without crashing", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const messages: ModelMessage[] = [
        { role: "user", content: "hello" }, // string content, not array
      ];
      assertModelMessageToolInputs(messages as never, "test");
      expect(errSpy).not.toHaveBeenCalled();
    } finally {
      errSpy.mockRestore();
    }
  });

  it("truncates large input values in the log to keep DevTools usable", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const huge = "x".repeat(2000);
      const messages: ModelMessage[] = [
        {
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolName: "x",
              toolCallId: "c1",
              input: huge, // ← non-object, will be coerced
            },
          ],
        },
      ];
      assertModelMessageToolInputs(messages as never, "test");
      expect(errSpy).toHaveBeenCalled();
      const logged = errSpy.mock.calls[0]
        .map((a) => (typeof a === "string" ? a : ""))
        .join(" ");
      // The log shouldn't contain 2000 chars of x.
      expect(logged.length).toBeLessThan(2000);
      // Should contain the truncation indicator.
      expect(logged).toContain("…");
    } finally {
      errSpy.mockRestore();
    }
  });
});

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { tool } from "ai";
import {
  isPlainObject,
  normalizeToolInput,
  normalizeToolInputForPersistence,
  schemaAcceptsEmptyObject,
} from "../tool-input-normalize";

describe("isPlainObject", () => {
  it.each([
    ["{}", {}, true],
    ["object", { a: 1 }, true],
    ["null", null, false],
    ["undefined", undefined, false],
    ["array", [1, 2, 3], false],
    ["empty array", [], false],
    ["string", "hello", false],
    ["empty string", "", false],
    ["number", 42, false],
    ["zero", 0, false],
    ["boolean true", true, false],
    ["boolean false", false, false],
  ])("%s -> %s", (_label, value, expected) => {
    expect(isPlainObject(value)).toBe(expected);
  });
});

describe("schemaAcceptsEmptyObject", () => {
  it("accepts a Zod object schema with all-optional properties", () => {
    const schema = z.object({ q: z.string().optional() });
    expect(schemaAcceptsEmptyObject(schema)).toBe(true);
  });

  it("accepts an empty Zod object schema", () => {
    expect(schemaAcceptsEmptyObject(z.object({}))).toBe(true);
  });

  it("rejects a Zod object schema with a required property", () => {
    const schema = z.object({ list: z.string() });
    expect(schemaAcceptsEmptyObject(schema)).toBe(false);
  });

  it("rejects a non-schema value", () => {
    expect(schemaAcceptsEmptyObject(undefined)).toBe(false);
    expect(schemaAcceptsEmptyObject(null)).toBe(false);
    expect(schemaAcceptsEmptyObject({})).toBe(false);
    expect(schemaAcceptsEmptyObject("nope")).toBe(false);
  });

  it("returns false rather than throwing on a buggy schema", () => {
    const buggy = {
      safeParse: () => {
        throw new Error("boom");
      },
    };
    expect(schemaAcceptsEmptyObject(buggy)).toBe(false);
  });
});

// Rule 5 (`{}` rescue) needs a real Tool whose inputSchema accepts {}.
// `tool({...})` is the AI SDK's helper; it returns a structurally-correct
// Tool with the Zod schema attached to `inputSchema`.
const noArgTool = tool({
  description: "no args",
  inputSchema: z.object({ q: z.string().optional() }),
  execute: async () => "ok",
});
const requiredArgTool = tool({
  description: "needs list",
  inputSchema: z.object({ list: z.string() }),
  execute: async () => "ok",
});

describe("normalizeToolInput — rule 1 (plain object passes through)", () => {
  it("keeps an object value verbatim", () => {
    const value = { a: 1, b: "x" };
    const out = normalizeToolInput({
      value,
      rawValue: undefined,
      tools: undefined,
      partType: "tool-anything",
      toolName: undefined,
    });
    expect(out).toEqual({ kind: "object", value });
  });

  it("keeps an empty object", () => {
    const out = normalizeToolInput({
      value: {},
      rawValue: undefined,
      tools: undefined,
      partType: "tool-anything",
      toolName: undefined,
    });
    expect(out).toEqual({ kind: "object", value: {} });
  });
});

describe("normalizeToolInput — rule 2 (string-encoded JSON object)", () => {
  it("parses a stringified JSON object", () => {
    const out = normalizeToolInput({
      value: '{"url":"https://example.com"}',
      rawValue: undefined,
      tools: undefined,
      partType: "tool-navigate",
      toolName: undefined,
    });
    expect(out).toEqual({
      kind: "object",
      value: { url: "https://example.com" },
    });
  });

  it("does NOT use a stringified non-object (string -> array, falls through)", () => {
    const out = normalizeToolInput({
      value: "[1,2,3]",
      rawValue: undefined,
      tools: undefined,
      partType: "tool-x",
      toolName: undefined,
    });
    expect(out.kind).toBe("drop");
  });

  it("does NOT use a stringified scalar", () => {
    const out = normalizeToolInput({
      value: '"hello"',
      rawValue: undefined,
      tools: undefined,
      partType: "tool-x",
      toolName: undefined,
    });
    expect(out.kind).toBe("drop");
  });
});

describe("normalizeToolInput — rule 3/4 (rawValue rescue)", () => {
  it("uses rawValue if it's a plain object and value is empty string", () => {
    const out = normalizeToolInput({
      value: "",
      rawValue: { url: "https://example.com" },
      tools: undefined,
      partType: "tool-navigate",
      toolName: undefined,
    });
    expect(out).toEqual({
      kind: "object",
      value: { url: "https://example.com" },
    });
  });

  it("parses rawValue from a stringified JSON object (partial-stream stash)", () => {
    const out = normalizeToolInput({
      value: undefined,
      rawValue: '{"url":"https://example.com"}',
      tools: undefined,
      partType: "tool-navigate",
      toolName: undefined,
    });
    expect(out).toEqual({
      kind: "object",
      value: { url: "https://example.com" },
    });
  });

  it("ignores a malformed rawValue string (incomplete JSON)", () => {
    const out = normalizeToolInput({
      value: undefined,
      rawValue: '{"url":"https://incomp',
      tools: undefined,
      partType: "tool-navigate",
      toolName: undefined,
    });
    // Without rule 5 rescue, drops.
    expect(out.kind).toBe("drop");
  });
});

describe("normalizeToolInput — rule 5 ({} rescue for empty-args tools)", () => {
  it("coerces `\"\"` to `{}` when the tool has all-optional schema (THE OPUS BUG)", () => {
    const out = normalizeToolInput({
      value: "",
      rawValue: undefined,
      tools: { "list-attribute-definitions": noArgTool },
      partType: "dynamic-tool",
      toolName: "list-attribute-definitions",
    });
    expect(out).toEqual({ kind: "object", value: {} });
  });

  it("coerces `null` to `{}` for empty-args tools", () => {
    const out = normalizeToolInput({
      value: null,
      rawValue: undefined,
      tools: { foo: noArgTool },
      partType: "dynamic-tool",
      toolName: "foo",
    });
    expect(out).toEqual({ kind: "object", value: {} });
  });

  it("coerces `42` to `{}` for empty-args tools", () => {
    const out = normalizeToolInput({
      value: 42,
      rawValue: undefined,
      tools: { foo: noArgTool },
      partType: "dynamic-tool",
      toolName: "foo",
    });
    expect(out).toEqual({ kind: "object", value: {} });
  });

  it("coerces `[]` to `{}` for empty-args tools (arrays are not objects)", () => {
    const out = normalizeToolInput({
      value: [],
      rawValue: undefined,
      tools: { foo: noArgTool },
      partType: "dynamic-tool",
      toolName: "foo",
    });
    expect(out).toEqual({ kind: "object", value: {} });
  });

  it("DROPS instead of coercing when the tool requires a property", () => {
    const out = normalizeToolInput({
      value: "",
      rawValue: undefined,
      tools: { "list-records-in-list": requiredArgTool },
      partType: "dynamic-tool",
      toolName: "list-records-in-list",
    });
    expect(out.kind).toBe("drop");
  });

  it("works with the tool-<name> part-type convention (built-in tools)", () => {
    const out = normalizeToolInput({
      value: "",
      rawValue: undefined,
      tools: { foo: noArgTool },
      partType: "tool-foo",
      toolName: undefined,
    });
    expect(out).toEqual({ kind: "object", value: {} });
  });

  it("does NOT coerce when tools is undefined (persistence layer)", () => {
    const out = normalizeToolInput({
      value: "",
      rawValue: undefined,
      tools: undefined,
      partType: "dynamic-tool",
      toolName: "foo",
    });
    expect(out.kind).toBe("drop");
  });
});

describe("normalizeToolInput — drop reasons report value type", () => {
  it("reports 'string' for a non-JSON string", () => {
    const out = normalizeToolInput({
      value: "hello",
      rawValue: undefined,
      tools: undefined,
      partType: "tool-x",
      toolName: undefined,
    });
    expect(out.kind).toBe("drop");
    if (out.kind === "drop") expect(out.reason).toMatch(/string/);
  });

  it("reports 'array' for an array", () => {
    const out = normalizeToolInput({
      value: [1, 2, 3],
      rawValue: undefined,
      tools: undefined,
      partType: "tool-x",
      toolName: undefined,
    });
    expect(out.kind).toBe("drop");
    if (out.kind === "drop") expect(out.reason).toMatch(/array/);
  });

  it("reports 'undefined' for missing", () => {
    const out = normalizeToolInput({
      value: undefined,
      rawValue: undefined,
      tools: undefined,
      partType: "tool-x",
      toolName: undefined,
    });
    expect(out.kind).toBe("drop");
    if (out.kind === "drop") expect(out.reason).toMatch(/undefined/);
  });
});

describe("normalizeToolInputForPersistence", () => {
  it("keeps a plain object", () => {
    const out = normalizeToolInputForPersistence({ value: { a: 1 } });
    expect(out).toEqual({ kind: "object", value: { a: 1 } });
  });

  it("recovers a stringified JSON object", () => {
    const out = normalizeToolInputForPersistence({ value: '{"a":1}' });
    expect(out).toEqual({ kind: "object", value: { a: 1 } });
  });

  it("does NOT coerce empty strings to {} (no schema available)", () => {
    const out = normalizeToolInputForPersistence({ value: "" });
    expect(out.kind).toBe("drop");
  });

  it("uses rawValue when present", () => {
    const out = normalizeToolInputForPersistence({
      value: "",
      rawValue: { a: 1 },
    });
    expect(out).toEqual({ kind: "object", value: { a: 1 } });
  });
});

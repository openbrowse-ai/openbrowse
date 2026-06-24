import { describe, expect, it, vi } from "vitest";
import { jsonSchemaToZod } from "../schema-to-zod";

describe("jsonSchemaToZod — top-level invariant (always returns object schema)", () => {
  it("rejects non-object inputs at the top level (THE PROVIDER 400 GUARD)", () => {
    // This is the central guarantee: for any MCP tool, a non-object input
    // (the model emits "" or null or 42) fails validateUIMessages and
    // never reaches the provider's tool_use.input field.
    const schema = jsonSchemaToZod({
      type: "object",
      properties: { q: { type: "string" } },
    });
    expect(schema.safeParse("").success).toBe(false);
    expect(schema.safeParse(null).success).toBe(false);
    expect(schema.safeParse(42).success).toBe(false);
    expect(schema.safeParse([]).success).toBe(false);
    expect(schema.safeParse("hello").success).toBe(false);
  });

  it("accepts a valid object", () => {
    const schema = jsonSchemaToZod({
      type: "object",
      properties: { q: { type: "string" } },
    });
    expect(schema.safeParse({ q: "x" }).success).toBe(true);
    expect(schema.safeParse({}).success).toBe(true); // q is optional
  });

  it("accepts {} for an all-optional schema (Opus rescue path)", () => {
    const schema = jsonSchemaToZod({
      type: "object",
      properties: { q: { type: "string" } },
      required: [],
    });
    expect(schema.safeParse({}).success).toBe(true);
  });

  it("rejects {} when properties are required", () => {
    const schema = jsonSchemaToZod({
      type: "object",
      properties: { list: { type: "string" } },
      required: ["list"],
    });
    expect(schema.safeParse({}).success).toBe(false);
  });
});

describe("jsonSchemaToZod — missing/malformed schema falls back to passthrough object", () => {
  it("undefined → passthrough object", () => {
    const schema = jsonSchemaToZod(undefined);
    expect(schema.safeParse({}).success).toBe(true);
    expect(schema.safeParse({ anything: 1 }).success).toBe(true);
    expect(schema.safeParse("").success).toBe(false);
    expect(schema.safeParse(null).success).toBe(false);
  });

  it("empty schema {} → passthrough object", () => {
    const schema = jsonSchemaToZod({});
    expect(schema.safeParse({}).success).toBe(true);
    expect(schema.safeParse({ x: 1 }).success).toBe(true);
    expect(schema.safeParse("").success).toBe(false);
  });

  it("schema with no type but properties → object", () => {
    const schema = jsonSchemaToZod({
      properties: { q: { type: "string" } },
    });
    expect(schema.safeParse({ q: "x" }).success).toBe(true);
    expect(schema.safeParse("").success).toBe(false);
  });

  it("top-level non-object schema (e.g. type: string) is coerced to passthrough object with a warn", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const schema = jsonSchemaToZod({ type: "string" });
      expect(schema.safeParse({}).success).toBe(true);
      expect(schema.safeParse("hello").success).toBe(false);
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe("jsonSchemaToZod — additionalProperties handling", () => {
  it("default (undefined) preserves unknown fields (passthrough)", () => {
    const schema = jsonSchemaToZod({
      type: "object",
      properties: { q: { type: "string" } },
    });
    const result = schema.safeParse({ q: "x", extra: "kept" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.data as Record<string, unknown>).extra).toBe("kept");
    }
  });

  it("additionalProperties: true preserves unknown fields", () => {
    const schema = jsonSchemaToZod({
      type: "object",
      properties: { q: { type: "string" } },
      additionalProperties: true,
    });
    expect(
      schema.safeParse({ q: "x", extra: "kept" }).success,
    ).toBe(true);
  });

  it("additionalProperties: false rejects unknown fields (strict)", () => {
    const schema = jsonSchemaToZod({
      type: "object",
      properties: { q: { type: "string" } },
      additionalProperties: false,
    });
    expect(schema.safeParse({ q: "x" }).success).toBe(true);
    expect(schema.safeParse({ q: "x", extra: "no" }).success).toBe(false);
  });
});

describe("jsonSchemaToZod — primitive types", () => {
  it("string", () => {
    const schema = jsonSchemaToZod({
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
    });
    expect(schema.safeParse({ name: "x" }).success).toBe(true);
    expect(schema.safeParse({ name: 1 }).success).toBe(false);
  });

  it("number", () => {
    const schema = jsonSchemaToZod({
      type: "object",
      properties: { n: { type: "number" } },
      required: ["n"],
    });
    expect(schema.safeParse({ n: 1.5 }).success).toBe(true);
    expect(schema.safeParse({ n: "1" }).success).toBe(false);
  });

  it("integer maps to number", () => {
    const schema = jsonSchemaToZod({
      type: "object",
      properties: { n: { type: "integer" } },
      required: ["n"],
    });
    expect(schema.safeParse({ n: 1 }).success).toBe(true);
  });

  it("boolean", () => {
    const schema = jsonSchemaToZod({
      type: "object",
      properties: { ok: { type: "boolean" } },
      required: ["ok"],
    });
    expect(schema.safeParse({ ok: true }).success).toBe(true);
    expect(schema.safeParse({ ok: "true" }).success).toBe(false);
  });

  it("null", () => {
    const schema = jsonSchemaToZod({
      type: "object",
      properties: { n: { type: "null" } },
      required: ["n"],
    });
    expect(schema.safeParse({ n: null }).success).toBe(true);
    expect(schema.safeParse({ n: 0 }).success).toBe(false);
  });
});

describe("jsonSchemaToZod — string formats", () => {
  it("uuid", () => {
    const schema = jsonSchemaToZod({
      type: "object",
      properties: { id: { type: "string", format: "uuid" } },
      required: ["id"],
    });
    expect(
      schema.safeParse({ id: "550e8400-e29b-41d4-a716-446655440000" }).success,
    ).toBe(true);
    expect(schema.safeParse({ id: "not-uuid" }).success).toBe(false);
  });

  it("email", () => {
    const schema = jsonSchemaToZod({
      type: "object",
      properties: { e: { type: "string", format: "email" } },
      required: ["e"],
    });
    expect(schema.safeParse({ e: "a@b.com" }).success).toBe(true);
    expect(schema.safeParse({ e: "nope" }).success).toBe(false);
  });

  it("url", () => {
    const schema = jsonSchemaToZod({
      type: "object",
      properties: { u: { type: "string", format: "url" } },
      required: ["u"],
    });
    expect(schema.safeParse({ u: "https://example.com" }).success).toBe(true);
    expect(schema.safeParse({ u: "not a url" }).success).toBe(false);
  });

  it("unknown format falls back to plain string", () => {
    const schema = jsonSchemaToZod({
      type: "object",
      properties: { x: { type: "string", format: "ipv4-or-something" } },
      required: ["x"],
    });
    expect(schema.safeParse({ x: "anything" }).success).toBe(true);
    expect(schema.safeParse({ x: 1 }).success).toBe(false);
  });
});

describe("jsonSchemaToZod — enum and const", () => {
  it("string enum", () => {
    const schema = jsonSchemaToZod({
      type: "object",
      properties: { kind: { enum: ["a", "b", "c"] } },
      required: ["kind"],
    });
    expect(schema.safeParse({ kind: "a" }).success).toBe(true);
    expect(schema.safeParse({ kind: "d" }).success).toBe(false);
  });

  it("mixed-type enum collapses to literal union", () => {
    const schema = jsonSchemaToZod({
      type: "object",
      properties: { v: { enum: ["a", 1, true] } },
      required: ["v"],
    });
    expect(schema.safeParse({ v: "a" }).success).toBe(true);
    expect(schema.safeParse({ v: 1 }).success).toBe(true);
    expect(schema.safeParse({ v: true }).success).toBe(true);
    expect(schema.safeParse({ v: 2 }).success).toBe(false);
  });

  it("const literal", () => {
    const schema = jsonSchemaToZod({
      type: "object",
      properties: { kind: { const: "fixed" } },
      required: ["kind"],
    });
    expect(schema.safeParse({ kind: "fixed" }).success).toBe(true);
    expect(schema.safeParse({ kind: "other" }).success).toBe(false);
  });
});

describe("jsonSchemaToZod — anyOf / oneOf", () => {
  it("[T, null] short-circuits to nullable T", () => {
    const schema = jsonSchemaToZod({
      type: "object",
      properties: {
        v: { anyOf: [{ type: "string" }, { type: "null" }] },
      },
      required: ["v"],
    });
    expect(schema.safeParse({ v: "x" }).success).toBe(true);
    expect(schema.safeParse({ v: null }).success).toBe(true);
    expect(schema.safeParse({ v: 1 }).success).toBe(false);
  });

  it("n-ary anyOf builds a union", () => {
    const schema = jsonSchemaToZod({
      type: "object",
      properties: {
        v: {
          anyOf: [{ type: "string" }, { type: "number" }, { type: "boolean" }],
        },
      },
      required: ["v"],
    });
    expect(schema.safeParse({ v: "x" }).success).toBe(true);
    expect(schema.safeParse({ v: 1 }).success).toBe(true);
    expect(schema.safeParse({ v: true }).success).toBe(true);
    expect(schema.safeParse({ v: [] }).success).toBe(false);
  });

  it("oneOf is treated like anyOf", () => {
    const schema = jsonSchemaToZod({
      type: "object",
      properties: {
        v: { oneOf: [{ type: "string" }, { type: "number" }] },
      },
      required: ["v"],
    });
    expect(schema.safeParse({ v: "x" }).success).toBe(true);
    expect(schema.safeParse({ v: 1 }).success).toBe(true);
  });

  it("single-element anyOf collapses to that schema", () => {
    const schema = jsonSchemaToZod({
      type: "object",
      properties: { v: { anyOf: [{ type: "string" }] } },
      required: ["v"],
    });
    expect(schema.safeParse({ v: "x" }).success).toBe(true);
    expect(schema.safeParse({ v: 1 }).success).toBe(false);
  });
});

describe("jsonSchemaToZod — arrays", () => {
  it("typed item schema", () => {
    const schema = jsonSchemaToZod({
      type: "object",
      properties: { ids: { type: "array", items: { type: "string" } } },
      required: ["ids"],
    });
    expect(schema.safeParse({ ids: ["a", "b"] }).success).toBe(true);
    expect(schema.safeParse({ ids: [1, 2] }).success).toBe(false);
  });

  it("missing items falls back to z.unknown elements", () => {
    const schema = jsonSchemaToZod({
      type: "object",
      properties: { xs: { type: "array" } },
      required: ["xs"],
    });
    expect(schema.safeParse({ xs: [1, "a", true] }).success).toBe(true);
  });

  it("tuple-form items", () => {
    const schema = jsonSchemaToZod({
      type: "object",
      properties: {
        pair: {
          type: "array",
          items: [{ type: "string" }, { type: "number" }],
        },
      },
      required: ["pair"],
    });
    expect(schema.safeParse({ pair: ["x", 1] }).success).toBe(true);
    expect(schema.safeParse({ pair: [1, "x"] }).success).toBe(false);
  });
});

describe("jsonSchemaToZod — nested objects", () => {
  it("nested object", () => {
    const schema = jsonSchemaToZod({
      type: "object",
      properties: {
        location: {
          type: "object",
          properties: {
            lat: { type: "number" },
            lon: { type: "number" },
          },
          required: ["lat", "lon"],
        },
      },
      required: ["location"],
    });
    expect(
      schema.safeParse({ location: { lat: 1, lon: 2 } }).success,
    ).toBe(true);
    expect(
      schema.safeParse({ location: { lat: "1", lon: 2 } }).success,
    ).toBe(false);
  });

  it("nested object with no properties (passthrough)", () => {
    const schema = jsonSchemaToZod({
      type: "object",
      properties: { meta: { type: "object" } },
      required: ["meta"],
    });
    expect(schema.safeParse({ meta: {} }).success).toBe(true);
    expect(schema.safeParse({ meta: { anything: 1 } }).success).toBe(true);
    expect(schema.safeParse({ meta: "string" }).success).toBe(false);
  });
});

describe("jsonSchemaToZod — allOf merges branches", () => {
  it("merges properties and required across branches", () => {
    const schema = jsonSchemaToZod({
      type: "object",
      properties: {
        wrapped: {
          allOf: [
            {
              type: "object",
              properties: { a: { type: "string" } },
              required: ["a"],
            },
            {
              type: "object",
              properties: { b: { type: "number" } },
              required: ["b"],
            },
          ],
        },
      },
      required: ["wrapped"],
    });
    expect(
      schema.safeParse({ wrapped: { a: "x", b: 1 } }).success,
    ).toBe(true);
    expect(schema.safeParse({ wrapped: { a: "x" } }).success).toBe(false);
  });
});

describe("jsonSchemaToZod — Attio-style real-world fixture", () => {
  // Mirrors the actual Attio MCP `list-attribute-definitions` tool: object
  // with all-optional properties, no required fields. The Opus bug:
  // model emits `input: ""`, the loose pre-fix schema accepted it, the
  // call landed in chat-db, every subsequent send 400'd Anthropic.
  // Post-fix: this schema rejects "" structurally.
  const attioSchema = {
    type: "object",
    properties: {
      object: {
        type: "string",
        description: "The object whose attributes to list",
      },
      query: { type: "string" },
      offset: { type: "number" },
      limit: { type: "number" },
    },
  } as const;

  it("rejects '' (the actual Opus bug input)", () => {
    const schema = jsonSchemaToZod(attioSchema);
    expect(schema.safeParse("").success).toBe(false);
  });

  it("rejects null (another Opus emission)", () => {
    const schema = jsonSchemaToZod(attioSchema);
    expect(schema.safeParse(null).success).toBe(false);
  });

  it("accepts {} (the correct empty-args call shape)", () => {
    const schema = jsonSchemaToZod(attioSchema);
    expect(schema.safeParse({}).success).toBe(true);
  });

  it("accepts the actual model-emitted input shape", () => {
    const schema = jsonSchemaToZod(attioSchema);
    expect(
      schema.safeParse({ object: "people", query: "founder", limit: 10 })
        .success,
    ).toBe(true);
  });

  it("accepts a partial input (only `object` set)", () => {
    const schema = jsonSchemaToZod(attioSchema);
    expect(schema.safeParse({ object: "people" }).success).toBe(true);
  });
});

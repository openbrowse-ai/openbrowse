import { z } from "zod";

/**
 * JSON Schema → Zod converter for MCP tools.
 *
 * Why this is its own module (not the AI SDK's built-in conversion):
 *   - MCP servers ship arbitrary JSON Schema in their `tool.inputSchema`
 *     advertisement. The AI SDK's tool surface expects a Zod (or
 *     JSON-Schema-shaped) `inputSchema` per tool, used by:
 *       a) `validateUIMessages` (validates incoming model-streamed input)
 *       b) `convertToModelMessages` (decides which fields to forward)
 *       c) per-provider tool-spec serialization (sent to the LLM)
 *   - We need conversion that's lenient enough to accept real-world
 *     servers (which use schema features the AI SDK doesn't natively
 *     map) but strict enough at the TOP LEVEL that a non-object input
 *     fails validation early — instead of slipping through and tripping
 *     a downstream provider error like
 *     `tool_use.input: Input should be a valid dictionary`.
 *
 * Top-level invariant: this function always returns a Zod schema whose
 * top-level type is `object`. A non-object input from any source (model
 * stream, persisted history, debug payload) fails `validateUIMessages`
 * structurally and never reaches the wire — which is the failure mode
 * `tool-input-normalize.ts` was written to backstop.
 *
 * Property-level looseness: object properties default to `passthrough()`
 * unless the schema explicitly says `additionalProperties: false`. Servers
 * frequently add fields between releases; passthrough preserves
 * forward-compat without weakening the top-level object check.
 *
 * Recognized JSON Schema features:
 *   - `type`: string, number, integer, boolean, array, object, null.
 *   - `enum`: string union.
 *   - `const`: literal value.
 *   - `anyOf` / `oneOf`: union (with the special `[T, null]` → nullable
 *     short-circuit). Both n-ary and binary unions are handled.
 *   - `properties` + `required`: object shape.
 *   - `items`: array element schema.
 *   - `additionalProperties: false` → strict object; otherwise passthrough.
 *   - `description`: applied via `.describe()` on the property.
 *   - `format`: "uuid", "email", "url", "date-time" map to Zod string
 *     refinements; unknown formats fall back to a plain string.
 *
 * Not recognized (intentionally falls back to z.unknown() at the property
 * level so model-emitted values still pass through):
 *   - `$ref`, `definitions` / `$defs` (would require schema resolution).
 *   - `patternProperties`, `dependencies`.
 *   - `minimum` / `maximum` / `pattern` / `multipleOf` (constraints).
 *
 * For a top-level malformed/missing schema (no `type`, no `properties`,
 * not `object`-shaped) the converter returns `z.object({}).passthrough()`
 * — accepts any object, rejects non-objects. This matches what an MCP
 * server would mean by "no input schema declared".
 */

type JsonSchema = {
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema | JsonSchema[];
  description?: string;
  enum?: unknown[];
  const?: unknown;
  default?: unknown;
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
  allOf?: JsonSchema[];
  additionalProperties?: boolean | JsonSchema;
  format?: string;
  // Permit unknown keys; we ignore them at the property level.
  [k: string]: unknown;
};

/** Apply a description if present, then return the schema. */
function withDescription<T extends z.ZodTypeAny>(
  schema: T,
  source: JsonSchema | undefined,
): T | z.ZodType {
  if (source?.description) {
    return schema.describe(source.description);
  }
  return schema;
}

function convertEnum(values: unknown[]): z.ZodTypeAny {
  // Zod enums require [string, ...string[]]. Mixed-type enums are rare in
  // practice (and not a tool-arg pattern), but if we see one we widen to
  // a literal union.
  const allStrings = values.every((v) => typeof v === "string");
  if (allStrings && values.length > 0) {
    return z.enum(values as [string, ...string[]]);
  }
  // Mixed or non-string enum: build a union of literals; if there's only
  // one value, use a literal directly. Empty enum is degenerate — accept
  // anything with z.unknown() rather than rejecting all values.
  if (values.length === 0) return z.unknown();
  if (values.length === 1) {
    return z.literal(values[0] as string | number | boolean);
  }
  // Build z.union of literals. Zod's literal accepts string|number|boolean.
  const literals = values.map((v) => {
    if (
      typeof v === "string" ||
      typeof v === "number" ||
      typeof v === "boolean"
    ) {
      return z.literal(v);
    }
    // Fall back for null / objects / arrays in the enum.
    if (v === null) return z.null();
    return z.unknown();
  });
  // Zod 4 union takes a tuple-like array.
  return z.union(literals as unknown as readonly [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]]);
}

function convertConst(value: unknown): z.ZodTypeAny {
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return z.literal(value);
  }
  if (value === null) return z.null();
  return z.unknown();
}

function convertString(schema: JsonSchema): z.ZodTypeAny {
  switch (schema.format) {
    case "uuid":
      return z.string().uuid();
    case "email":
      return z.string().email();
    case "url":
    case "uri":
      return z.string().url();
    case "date-time":
      return z.string().datetime({ offset: true });
    default:
      return z.string();
  }
}

function convertArray(schema: JsonSchema): z.ZodTypeAny {
  const items = schema.items;
  // tuple form (`items: [s1, s2, ...]`) — JSON Schema's positional tuple.
  // Map each position to its schema; if the schema is missing, accept any.
  if (Array.isArray(items)) {
    const tupleParts = items.map((it) => convertProperty(it));
    if (tupleParts.length === 0) return z.array(z.unknown());
    // z.tuple(...) signature in Zod 4.
    return z.tuple(
      tupleParts as unknown as readonly [z.ZodTypeAny, ...z.ZodTypeAny[]],
    );
  }
  // Single-schema form.
  if (items && typeof items === "object") {
    return z.array(convertProperty(items));
  }
  return z.array(z.unknown());
}

function convertProperty(schema: JsonSchema | undefined): z.ZodTypeAny {
  if (!schema || typeof schema !== "object") return z.unknown();

  // const wins over anything else.
  if ("const" in schema) {
    return withDescription(convertConst(schema.const), schema) as z.ZodTypeAny;
  }

  if (schema.enum && Array.isArray(schema.enum)) {
    return withDescription(convertEnum(schema.enum), schema) as z.ZodTypeAny;
  }

  // Union forms. Special-case `[T, null]` → nullable T, which is the most
  // common idiom for "T or null" in JSON Schema.
  const variants = schema.anyOf ?? schema.oneOf;
  if (variants && Array.isArray(variants) && variants.length > 0) {
    if (variants.length === 2) {
      const nullVariant = variants.find((v) => v.type === "null");
      const otherVariant = variants.find((v) => v.type !== "null");
      if (nullVariant && otherVariant) {
        return withDescription(
          convertProperty(otherVariant).nullable(),
          schema,
        ) as z.ZodTypeAny;
      }
    }
    // n-ary union. Zod 4's union requires at least 2 elements.
    if (variants.length === 1) {
      return withDescription(
        convertProperty(variants[0]),
        schema,
      ) as z.ZodTypeAny;
    }
    const parts = variants.map((v) => convertProperty(v));
    return withDescription(
      z.union(
        parts as unknown as readonly [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]],
      ),
      schema,
    ) as z.ZodTypeAny;
  }

  // allOf: Zod has no clean "intersection of N schemas" but in practice
  // MCP servers use this for object refinement. Take the union of all
  // properties from all branches; merge `required`.
  if (schema.allOf && Array.isArray(schema.allOf) && schema.allOf.length > 0) {
    const merged: JsonSchema = { type: "object", properties: {}, required: [] };
    for (const branch of schema.allOf) {
      if (branch.properties) {
        merged.properties = { ...merged.properties, ...branch.properties };
      }
      if (branch.required) {
        merged.required = [
          ...(merged.required ?? []),
          ...branch.required,
        ];
      }
    }
    return withDescription(
      convertObjectSchema(merged),
      schema,
    ) as z.ZodTypeAny;
  }

  // type can be a string or array. JSON Schema allows multi-type
  // declarations (`type: ["string", "null"]`) to mean "any of these".
  // When we see an array, fan out into a union — collapsing to
  // `type[0]` would silently drop the other branches and reject inputs
  // the schema actually allows.
  if (Array.isArray(schema.type) && schema.type.length > 1) {
    // Build per-type sub-schemas by re-entering convertProperty with
    // each individual type. We strip `type` so a recursive call with
    // `enum`/`anyOf` on the same schema doesn't double-fire.
    const { type: _t, ...rest } = schema;
    void _t;
    const variants = schema.type.map((t) =>
      convertProperty({ ...rest, type: t }),
    );
    if (variants.length === 1) {
      return withDescription(variants[0], schema) as z.ZodTypeAny;
    }
    return withDescription(
      z.union(
        variants as unknown as readonly [
          z.ZodTypeAny,
          z.ZodTypeAny,
          ...z.ZodTypeAny[]
        ],
      ),
      schema,
    ) as z.ZodTypeAny;
  }
  const type = Array.isArray(schema.type) ? schema.type[0] : schema.type;

  switch (type) {
    case "string":
      return withDescription(convertString(schema), schema) as z.ZodTypeAny;
    case "number":
    case "integer":
      return withDescription(z.number(), schema) as z.ZodTypeAny;
    case "boolean":
      return withDescription(z.boolean(), schema) as z.ZodTypeAny;
    case "array":
      return withDescription(convertArray(schema), schema) as z.ZodTypeAny;
    case "object":
      return withDescription(
        convertObjectSchema(schema),
        schema,
      ) as z.ZodTypeAny;
    case "null":
      return withDescription(z.null(), schema) as z.ZodTypeAny;
    default:
      // No type but properties present → object.
      if (schema.properties) {
        return withDescription(
          convertObjectSchema(schema),
          schema,
        ) as z.ZodTypeAny;
      }
      // Truly unknown: accept anything at the property level. This is
      // safer than rejecting — at the TOP level we still enforce object
      // shape via `jsonSchemaToZod`.
      return withDescription(z.unknown(), schema) as z.ZodTypeAny;
  }
}

function convertObjectSchema(schema: JsonSchema): z.ZodTypeAny {
  const required = new Set(schema.required ?? []);
  const props = schema.properties ?? {};

  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [key, propSchema] of Object.entries(props)) {
    const prop = convertProperty(propSchema);
    shape[key] = required.has(key) ? prop : prop.optional();
  }

  // Closed shape only when explicitly opted in. Default is passthrough so
  // an MCP server adding new optional fields doesn't strip them.
  // additionalProperties: false → strict; true | undefined | object → passthrough.
  const isStrict = schema.additionalProperties === false;
  const base = z.object(shape);
  if (isStrict) {
    return base.strict();
  }
  return base.passthrough();
}

/**
 * Top-level entry point. Always returns a Zod schema whose top-level type
 * is `object` — a non-object input fails validation structurally before
 * ever reaching the provider. See module-level doc.
 */
export function jsonSchemaToZod(schema: JsonSchema | undefined): z.ZodTypeAny {
  // Missing or malformed schema → accept any object, reject non-objects.
  if (!schema || typeof schema !== "object") {
    return z.object({}).passthrough();
  }

  // Top-level object (the common case). For a multi-type at top level
  // (which is non-conformant per the MCP spec — tool inputs must be
  // objects — but tolerated): if `"object"` is one of the listed types,
  // treat the schema as object-typed. Otherwise fall through to the
  // non-object warning below.
  const types = Array.isArray(schema.type)
    ? schema.type
    : schema.type !== undefined
      ? [schema.type]
      : [];
  if (types.includes("object") || schema.properties) {
    return convertObjectSchema(schema);
  }
  const type = types[0];

  // Top-level non-object schema: this is invalid for an MCP tool input
  // (the spec requires object). Coerce to a passthrough object so the
  // call doesn't crash the entire tool registry, but log once so the
  // server author can fix it.
  if (type && type !== "object") {
    if (typeof console !== "undefined" && console.warn) {
      console.warn(
        `[mcp/schema-to-zod] tool inputSchema has top-level type=${JSON.stringify(
          schema.type,
        )} (must be "object"); coercing to passthrough object.`,
      );
    }
  }
  return z.object({}).passthrough();
}

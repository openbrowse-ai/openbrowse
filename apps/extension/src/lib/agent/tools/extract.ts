import { generateObject, jsonSchema } from "ai";
import { z } from "zod";
import { getActiveUserTab } from "../active-tab";
import { getCurrentAgentModel } from "../agent-transport";
import { captureSnapshot, captureSnapshotWithUrlIds } from "../snapshot-capture";
import type { BrowserTool } from "../types";

/**
 * Extract structured data from the page using the accessibility tree.
 *
 * Implementation mirrors Stagehand's `page.extract()` pattern:
 *  1. Capture a scoped a11y snapshot with URL references replaced by small
 *     integer IDs (anti-hallucination).
 *  2. Transform the user-provided JSON Schema: every string field marked
 *     `{type: "string", format: "uri"}` becomes `{type: "integer"}` so the
 *     LLM emits IDs instead of fabricated URLs.
 *  3. Run `generateObject` against the agent's main model with the transformed
 *     schema.
 *  4. Walk the LLM output and rehydrate the URL integers back to real URLs
 *     using the map from the capture.
 */

type JSONSchemaObject = {
  type?: string | string[];
  format?: string;
  properties?: Record<string, JSONSchemaObject>;
  items?: JSONSchemaObject;
  required?: string[];
  description?: string;
  anyOf?: JSONSchemaObject[];
  oneOf?: JSONSchemaObject[];
  // ...passthrough of any other JSON Schema keys
  [key: string]: unknown;
};

type UrlPath = (string | "*")[];

const parameters = z.object({
  instruction: z
    .string()
    .describe(
      "Natural-language description of what to extract (e.g. 'the top 3 non-sponsored results with title, price, and url').",
    ),
  selector: z
    .string()
    .optional()
    .describe(
      "Optional CSS selector to scope extraction to a subtree. Use element selectors (e.g. 'main', 'ul', '.s-main-slot') or IDs (e.g. '#search') — do NOT use [role=\"main\"] since CSS attribute selectors don't match implicit ARIA roles. Strongly recommended on heavy pages.",
    ),
  schema: z
    .any()
    .optional()
    .describe(
      "JSON Schema describing the expected output structure. MUST be passed as an object literal (e.g. {type: 'object', properties: {...}}), NOT as a JSON-encoded string. For URL fields, mark them as {\"type\": \"string\", \"format\": \"uri\"} to get reliable URL extraction (the system replaces URLs with numeric IDs the LLM can reference without hallucination). Omit for free-form text extraction.",
    ),
});

type Input = z.infer<typeof parameters>;
type Output = {
  data: unknown;
  warnings?: string[];
};

const EXTRACT_SYSTEM_PROMPT = `You are extracting structured data from a webpage's accessibility tree.

Rules:
- If the user asks for a 'list' or 'all' of something, you MUST extract ALL items that match — do not stop at a few.
- Print exact text from the tree — do not paraphrase, shorten, or normalize values.
- For URL fields (integer type in the schema): respond with ONLY the numeric urlId from the tree (the integer after "urlId="). Do NOT emit actual URLs — the system will rehydrate them after your response.
- If a field cannot be found in the tree, return null or an empty string for that field.
- Do not invent data that is not present in the tree.
- Ignore sponsored results / advertisements unless the user explicitly asks for them.`;

export const extractTool: BrowserTool<Input, Output> = {
  name: "extract",
  description:
    "Extract structured data from the current page using its accessibility tree. Provide an instruction (what to extract) and optionally a JSON Schema (output shape) and a CSS selector (subtree scope). Preferred over raw DOM-scraping via executeOnPage for text-based data like search results, product lists, table rows, or article content. For URL fields in the schema, use {type: 'string', format: 'uri'} — the tool substitutes URLs with numeric IDs to prevent hallucination and rehydrates them automatically.",
  parameters,
  execute: async ({ instruction, selector, schema }) => {
    const model = getCurrentAgentModel();
    if (!model) {
      // Invariant: if the tool is running, the agent is running, so the model
      // must exist. Treat as a programmer error, not a user-actionable issue.
      throw new Error(
        "extract: agent model not initialized (internal invariant violated)",
      );
    }

    const tab = await getActiveUserTab();
    const tabId = tab.id!;

    // Normalize the user-supplied schema. Some LLMs (notably Claude) hedge on
    // `z.any()` parameters and emit complex nested values as JSON-encoded
    // STRINGS rather than parsed objects. If we don't unwrap that, the schema
    // flows through `jsonSchema()` as a string, gets sent to the provider as a
    // string at `output_config.format.schema`, and the API rejects it with
    // "is not of type 'object', 'boolean'" (Anthropic's exact failure mode).
    let inputSchema: JSONSchemaObject;
    if (schema == null) {
      inputSchema = {
        type: "object",
        properties: {
          extraction: {
            type: "string",
            description: "Extracted content matching the instruction",
          },
        },
        required: ["extraction"],
      };
    } else if (typeof schema === "string") {
      try {
        const parsed = JSON.parse(schema);
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
          throw new Error(
            "extract: schema parameter parsed to a non-object value. Provide a JSON Schema object (e.g. { type: 'object', properties: {...} }), not a string, array, or primitive.",
          );
        }
        inputSchema = parsed as JSONSchemaObject;
      } catch (err) {
        if (err instanceof Error && err.message.startsWith("extract:")) throw err;
        throw new Error(
          "extract: schema parameter was passed as a string but didn't parse as JSON. Pass the schema as a JSON object literal, not a stringified version.",
        );
      }
    } else if (typeof schema === "object" && !Array.isArray(schema)) {
      inputSchema = schema as JSONSchemaObject;
    } else {
      throw new Error(
        `extract: schema parameter must be a JSON Schema object or omitted; got ${
          Array.isArray(schema) ? "array" : typeof schema
        }.`,
      );
    }

    const urlPaths: UrlPath[] = [];
    const transformedSchema = transformSchemaForUrls(inputSchema, urlPaths, []);

    // Capture the page snapshot. If the schema has any URL fields, render
    // links as `[urlId=N]` so we can rehydrate after the LLM call. Otherwise,
    // render URLs inline (cleaner for free-form text extraction — avoids
    // confusing the LLM with mystery integer references it can't resolve).
    let snapshotText: string;
    let urlMap: Map<number, string>;
    if (urlPaths.length > 0) {
      const result = await captureSnapshotWithUrlIds(tabId, { selector });
      snapshotText = result.snapshotText;
      urlMap = result.urlMap;
    } else {
      const result = await captureSnapshot(tabId, { selector, mode: "full" });
      snapshotText = result.snapshotText;
      urlMap = new Map();
    }

    // Root-wrap if the user's schema isn't an object type. OpenAI/Gemini
    // structured output both require `type: "object"` at the root.
    const { schema: rootedSchema, wrapped } = ensureObjectRoot(transformedSchema);

    // OpenAI strict mode (and most other providers' structured-output modes)
    // require every object schema to have `additionalProperties: false` and
    // to list every property in `required`. Normalize before sending.
    const strictSchema = makeSchemaStrict(rootedSchema);

    const prompt = [
      `Instruction: ${instruction}`,
      ``,
      `Accessibility tree:`,
      snapshotText,
    ].join("\n");

    let object: unknown;
    try {
      const result = await generateObject({
        model,
        schema: jsonSchema(strictSchema as never),
        system: EXTRACT_SYSTEM_PROMPT,
        prompt,
      });
      object = result.object;
    } catch (err) {
      throw new Error(
        `extract: LLM call failed — ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }

    // Unwrap the root-wrapping we applied for OpenAI compat.
    if (
      wrapped &&
      typeof object === "object" &&
      object !== null &&
      "result" in (object as Record<string, unknown>)
    ) {
      object = (object as Record<string, unknown>).result;
    }

    const warnings: string[] = [];
    rehydrateUrls(object, urlPaths, urlMap, warnings);

    return warnings.length > 0
      ? { data: object, warnings }
      : { data: object };
  },
};

// ============================================================================
// Schema walker — replaces URL fields with integer fields, records paths.
// ============================================================================

function transformSchemaForUrls(
  schema: JSONSchemaObject,
  paths: UrlPath[],
  currentPath: UrlPath,
): JSONSchemaObject {
  // Leaf: URL string → integer (urlId).
  if (
    schema.type === "string" &&
    (schema.format === "uri" || schema.format === "url")
  ) {
    paths.push([...currentPath]);
    return {
      type: "integer",
      description:
        (schema.description ? schema.description + " " : "") +
        "(Emit the urlId integer from the accessibility tree, not the URL itself.)",
    };
  }

  // Object: recurse into properties.
  if (schema.type === "object" && schema.properties) {
    const newProps: Record<string, JSONSchemaObject> = {};
    for (const [key, val] of Object.entries(schema.properties)) {
      newProps[key] = transformSchemaForUrls(val, paths, [...currentPath, key]);
    }
    return { ...schema, properties: newProps };
  }

  // Array: recurse into items with a "*" path segment.
  if (schema.type === "array" && schema.items) {
    return {
      ...schema,
      items: transformSchemaForUrls(schema.items, paths, [
        ...currentPath,
        "*",
      ]),
    };
  }

  // anyOf/oneOf: bail out — URL rehydration through unions is fragile.
  // The LLM will see the original schema and likely emit URLs directly.
  if (schema.anyOf || schema.oneOf) {
    return schema;
  }

  return schema;
}

// ============================================================================
// Root wrapping — OpenAI/Gemini structured output require `type: "object"`
// at the root of the schema. If the user passes a top-level array or scalar
// schema, wrap it so the LLM emits `{ result: <actual> }`, then unwrap after.
// ============================================================================

function ensureObjectRoot(schema: JSONSchemaObject): {
  schema: JSONSchemaObject;
  wrapped: boolean;
} {
  if (schema.type === "object") return { schema, wrapped: false };
  return {
    schema: {
      type: "object",
      properties: { result: schema },
      required: ["result"],
    },
    wrapped: true,
  };
}

// ============================================================================
// Strict-mode normalization — OpenAI strict JSON schema requires every object
// schema to have `additionalProperties: false` and to list every property in
// `required`. Gemini has similar constraints. Apply recursively.
//
// This is aggressive: if the user declared some properties as optional (by
// omitting them from `required`), we still force them into `required`. The
// LLM can emit null for values it can't find; that's more compatible across
// providers than trying to preserve optional semantics.
// ============================================================================

function makeSchemaStrict(schema: JSONSchemaObject): JSONSchemaObject {
  if (schema.type === "object" && schema.properties) {
    const strictProps: Record<string, JSONSchemaObject> = {};
    const propKeys = Object.keys(schema.properties);
    for (const key of propKeys) {
      strictProps[key] = makeSchemaStrict(schema.properties[key]);
    }
    return {
      ...schema,
      properties: strictProps,
      additionalProperties: false,
      required: propKeys,
    };
  }
  if (schema.type === "array" && schema.items) {
    return {
      ...schema,
      items: makeSchemaStrict(schema.items),
    };
  }
  return schema;
}

// ============================================================================
// Rehydration walker — replaces integers at recorded paths with URLs.
// ============================================================================

function rehydrateUrls(
  data: unknown,
  paths: UrlPath[],
  urlMap: Map<number, string>,
  warnings: string[],
): void {
  for (const path of paths) {
    applyAtPath(data, path, (value) => {
      if (typeof value !== "number") return value;
      const url = urlMap.get(value);
      if (url == null) {
        warnings.push(
          `urlId ${value} not found in snapshot URL map — leaving as integer`,
        );
        return value;
      }
      return url;
    });
  }
}

function applyAtPath(
  obj: unknown,
  path: UrlPath,
  transform: (v: unknown) => unknown,
): void {
  if (path.length === 0 || obj == null) return;
  const [head, ...rest] = path;

  if (head === "*") {
    if (!Array.isArray(obj)) return;
    for (const item of obj) {
      applyAtPath(item, rest, transform);
    }
    return;
  }

  if (typeof obj !== "object") return;
  const record = obj as Record<string, unknown>;

  if (rest.length === 0) {
    record[head] = transform(record[head]);
    return;
  }

  applyAtPath(record[head], rest, transform);
}

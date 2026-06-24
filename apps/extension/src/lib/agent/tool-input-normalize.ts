import type { ToolSet } from "ai";

/**
 * Normalize a tool-call `input` value into a plain JSON object suitable for
 * provider wire formats, or signal that the tool part cannot be salvaged.
 *
 * Background — why this exists at all:
 *  - The Anthropic Messages API requires every `tool_use.input` to be a JSON
 *    object (dictionary). A non-object (`""`, `null`, `0`, `[]`, an
 *    arbitrary string) is rejected at request validation with
 *    `messages.<i>.content.<j>.tool_use.input: Input should be a valid
 *    dictionary`. The error path includes a *numeric model-message index*
 *    only — no tool name, no source UI message id — which makes diagnosis
 *    from a user error report nearly impossible.
 *  - Some providers (Gemini, Vertex) coerce non-object inputs to `{}` or a
 *    `Struct` silently in their SDK adapter, which is why the same
 *    conversation history that 400s on Opus quietly succeeds when retried
 *    on Gemini.
 *  - The model can produce a non-object `input` for several reasons:
 *      a) Opus glitch on no-arg tool calls — emits `input: ""` instead of
 *         `input: {}`.
 *      b) JSON-streamed `input` finishes as a stringified object (`'{"x":1}'`)
 *         instead of being parsed by the SDK's argument streamer.
 *      c) An MCP server with a permissive `inputSchema` (e.g. `z.any()` or
 *         `z.record(string, any)` from `jsonSchemaToZod`'s fallback paths)
 *         lets a non-object input pass `validateUIMessages`.
 *      d) Historical chat-db rows persisted with the bad `input` shape
 *         before this normalizer existed.
 *
 * The normalizer is the single chokepoint for outbound tool inputs. It runs
 * inside the transport's `repairToolPart` and on every code path that
 * persists or re-loads tool parts, so a non-object input cannot reach
 * `convertToModelMessages` from any direction.
 *
 * Recovery rules, in order:
 *   1. `value` is already a plain object → keep verbatim.
 *   2. `value` is a string that JSON-parses to a plain object → parse and
 *      use it. Recovers Opus's stringified-object emissions.
 *   3. `rawValue` (the SDK's partial-streamed argument blob) is a plain
 *      object → use it.
 *   4. `rawValue` is a string that JSON-parses to a plain object → use it.
 *      Recovers fully-streamed-but-not-yet-parsed args.
 *   5. The tool's `inputSchema` accepts `{}` (no required fields) →
 *      coerce to `{}`. This rescues the *real-world* fail case behind the
 *      Opus bug: a no-arg MCP tool call where the model emitted `input: ""`.
 *   6. Otherwise → drop. The part cannot be sent without a valid input,
 *      and substituting `{}` would fail the tool's strict required-fields
 *      schema in `validateUIMessages` ("Type validation failed ...
 *      path: ['list']") and crash the whole turn instead of just dropping
 *      one tool call.
 */
export type NormalizeResult =
  | { kind: "object"; value: Record<string, unknown> }
  | { kind: "drop"; reason: string };

/**
 * True iff `v` is a plain JSON-shaped object dictionary — accepts object
 * literals (`{}`, `Object.create(null)`) and rejects arrays, `null`,
 * primitives, AND non-plain objects (Date, Map, Set, class instances,
 * RegExp, etc.).
 *
 * The Anthropic API requires `tool_use.input` to be a plain JSON object;
 * a `Date` or class instance would JSON-serialize to a non-conforming
 * shape (or throw on circular references). The model can't *emit* a
 * non-plain object directly — it only emits JSON — but a future code
 * path that programmatically injects a tool input could, and the
 * normalizer is the chokepoint that catches it.
 *
 * Implementation: walks the prototype chain. A plain object's prototype
 * is either `Object.prototype` (literal `{}`) or `null`
 * (`Object.create(null)`). Any other prototype indicates a class
 * instance or built-in (Date, Map, etc.).
 */
export function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== "object" || v === null) return false;
  if (Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/**
 * Try to parse `s` as JSON. Returns the parsed value on success, `undefined`
 * on any failure (syntax error, empty string, whitespace-only). Never throws.
 */
function tryParseJson(s: string): unknown {
  const trimmed = s.trim();
  if (trimmed.length === 0) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

/**
 * Whether a tool's input schema accepts an empty object `{}`. Used by
 * normalizeToolInput's rule 5 to decide whether a no-arg tool call can be
 * rescued by coercing its missing/malformed input to `{}`.
 *
 * Implementation: ducktype against the Zod-like surface (`safeParse`). The
 * AI SDK passes Zod schemas through unchanged, so this works for both
 * built-in tools (Zod schemas defined in lib/agent/tools/*.ts) and MCP
 * tools (Zod schemas produced by `jsonSchemaToZod`). For tools whose
 * schema doesn't expose `safeParse` (synthetic/test tools), we
 * conservatively return false — the part is dropped rather than being
 * coerced into a value the schema may or may not accept.
 */
export function schemaAcceptsEmptyObject(inputSchema: unknown): boolean {
  if (!inputSchema || typeof inputSchema !== "object") return false;
  const sp = (inputSchema as { safeParse?: unknown }).safeParse;
  if (typeof sp !== "function") return false;
  try {
    const result = (sp as (x: unknown) => { success: boolean }).call(
      inputSchema,
      {},
    );
    return result?.success === true;
  } catch {
    return false;
  }
}

/**
 * Look up the inputSchema for a tool given its UI part `type` and `toolName`.
 *
 * UI parts use two type conventions:
 *  - `dynamic-tool` (the universal one): the actual tool name lives in
 *    `toolName`. Used for MCP tools, subagent delegate, and any tool
 *    registered by registry path.
 *  - `tool-<name>` (the AI SDK's "static" tool convention): the tool name
 *    is the suffix after `tool-`. Used by built-in browser tools.
 *
 * The agent's `ToolSet` is keyed on the tool name in both cases.
 */
function lookupToolSchema(
  tools: ToolSet | undefined,
  partType: string,
  toolName: string | undefined,
): unknown {
  if (!tools) return undefined;
  if (partType === "dynamic-tool" && typeof toolName === "string") {
    const t = tools[toolName];
    return t?.inputSchema;
  }
  if (partType.startsWith("tool-")) {
    const name = partType.slice("tool-".length);
    const t = tools[name];
    return t?.inputSchema;
  }
  return undefined;
}

/**
 * Normalize a tool-call input. See module-level doc comment for the full
 * recovery ladder.
 *
 * Args:
 *   value     — the part's `input` field (any shape).
 *   rawValue  — the part's `rawInput` field (any shape). The AI SDK
 *               occasionally stashes a partial JSON string here when args
 *               are still streaming.
 *   tools     — the agent's ToolSet, used to check whether the tool
 *               accepts `{}` (rule 5). Optional; if absent, rule 5 is
 *               skipped and the part is dropped instead of coerced.
 *   partType  — the UI part's `type` field (`"dynamic-tool"` or
 *               `"tool-<name>"`). Used to resolve the tool's schema.
 *   toolName  — the tool's name. For `dynamic-tool` parts this is the
 *               `toolName` field; for `tool-<name>` parts the caller
 *               can pass undefined and we'll derive it from `partType`.
 */
export function normalizeToolInput(args: {
  value: unknown;
  rawValue: unknown;
  tools: ToolSet | undefined;
  partType: string;
  toolName: string | undefined;
}): NormalizeResult {
  const { value, rawValue, tools, partType, toolName } = args;

  // Rule 1 — already a plain object.
  if (isPlainObject(value)) {
    return { kind: "object", value };
  }

  // Rule 2 — value is a stringified JSON object.
  if (typeof value === "string") {
    const parsed = tryParseJson(value);
    if (isPlainObject(parsed)) {
      return { kind: "object", value: parsed };
    }
  }

  // Rule 3 — rawValue is a plain object.
  if (isPlainObject(rawValue)) {
    return { kind: "object", value: rawValue };
  }

  // Rule 4 — rawValue is a stringified JSON object (the SDK's
  // partial-stream stash, or a complete blob the SDK didn't promote
  // into `input` for some reason).
  if (typeof rawValue === "string") {
    const parsed = tryParseJson(rawValue);
    if (isPlainObject(parsed)) {
      return { kind: "object", value: parsed };
    }
  }

  // Rule 5 — the tool accepts {} (i.e. all properties optional, no
  // required fields). This is the rescue path for the actual real-world
  // bug: Opus emitting `input: ""` for a no-arg MCP tool.
  const schema = lookupToolSchema(tools, partType, toolName);
  if (schemaAcceptsEmptyObject(schema)) {
    return { kind: "object", value: {} };
  }

  // Rule 6 — irrecoverable. Drop.
  const valueRepr =
    value === undefined
      ? "undefined"
      : value === null
        ? "null"
        : Array.isArray(value)
          ? "array"
          : typeof value;
  return {
    kind: "drop",
    reason: `non-object tool input (${valueRepr}) and no rescue available`,
  };
}

/**
 * Variant of `normalizeToolInput` for the *persistence* layer (serialize/
 * deserialize/migration). It applies the same recovery ladder but never
 * has access to a `ToolSet`, so rule 5 (schema-aware `{}` coercion) is
 * skipped. A part the persistence layer cannot recover is dropped from
 * disk, leaving the transport's send-time pass with a clean view.
 */
export function normalizeToolInputForPersistence(args: {
  value: unknown;
  rawValue?: unknown;
}): NormalizeResult {
  return normalizeToolInput({
    value: args.value,
    rawValue: args.rawValue,
    tools: undefined,
    partType: "",
    toolName: undefined,
  });
}

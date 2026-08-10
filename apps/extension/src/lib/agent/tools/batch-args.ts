/**
 * Dependency-free helpers shared by the `batch` tool, the chat UI, and
 * `tool-usage`'s scanner.
 *
 * Kept separate from `./batch` on purpose: that module imports every
 * batchable tool (and therefore OPFS, the model registry, the CDP
 * capture layer...). Importers that only need to *read* a batch tool
 * call — a React block rendering the invocation list, or the per-step
 * usage scanner — must not drag that graph in.
 */

/** The tool name the model calls. Single source of truth for string keys. */
export const BATCH_TOOL_NAME = "batch";

/**
 * Read the model-authored activity description out of a (possibly
 * malformed, possibly mid-stream) `batch` tool-call input.
 *
 * Returns `null` for anything unusable so the renderer can fall back to a
 * neutral label derived from the invocation list. Calls persisted before
 * `description` existed hit this path, as does the window while the input
 * is still streaming in.
 */
export function readBatchDescription(input: unknown): string | null {
  const raw = (input as { description?: unknown } | null | undefined)
    ?.description;
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim().replace(/[.…]+$/, "").trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** One entry of a `batch` call's `invocations` array, as the model sends it. */
export interface BatchInvocationInput {
  name: string;
  arguments?: unknown;
}

/** One entry of a `batch` call's `results` array. */
export interface BatchInvocationResult {
  /** Echoes the requested tool name so results stay self-describing. */
  name: string;
  /**
   * Whether this invocation produced usable data. False for a thrown
   * tool, a rejected argument, a non-batchable name, a cancelled run —
   * and for a tool that reported failure in-band (see
   * {@link readInBandError}).
   */
  ok: boolean;
  /**
   * The tool's own return value. Absent when the invocation never ran.
   * Present even when `!ok` if the tool returned an in-band error, so the
   * model and the child's own renderer keep the full payload.
   */
  output?: unknown;
  /** Why this one invocation failed. Present iff `!ok`. */
  error?: string;
}

export interface BatchOutput {
  results: BatchInvocationResult[];
}

/**
 * Coerce a model-supplied `arguments` value into a plain object.
 *
 * Mirrors the defensive unwrapping `extract` already does for its
 * `schema` param: `z.any()` parameters make some models (notably Claude)
 * hedge and emit nested values as JSON-encoded STRINGS rather than
 * parsed objects. Without this, `{"tab":"t1"}` arrives as a string and
 * every invocation fails schema validation for no good reason.
 */
export function normalizeInvocationArguments(
  raw: unknown,
): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  if (raw == null) return { ok: true, value: {} };
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (trimmed === "") return { ok: true, value: {} };
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return {
        ok: false,
        error:
          "`arguments` was a string but did not parse as JSON. Pass an object literal (e.g. {tab: 't1'}), not a stringified version.",
      };
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return {
        ok: false,
        error:
          "`arguments` parsed to a non-object value. Pass an object literal (e.g. {tab: 't1'}).",
      };
    }
    return { ok: true, value: parsed as Record<string, unknown> };
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return {
      ok: false,
      error: `\`arguments\` must be an object or omitted; got ${
        Array.isArray(raw) ? "array" : typeof raw
      }.`,
    };
  }
  return { ok: true, value: raw as Record<string, unknown> };
}

/**
 * Read the `invocations` array out of a (possibly malformed, possibly
 * mid-stream) `batch` tool-call input. Entries without a string `name`
 * are dropped — a partially-streamed input is normal while the UI
 * renders an in-flight call.
 */
export function readBatchInvocations(input: unknown): BatchInvocationInput[] {
  const raw = (input as { invocations?: unknown } | null | undefined)
    ?.invocations;
  if (!Array.isArray(raw)) return [];
  const out: BatchInvocationInput[] = [];
  for (const entry of raw) {
    const name = (entry as { name?: unknown } | null | undefined)?.name;
    if (typeof name !== "string" || name.length === 0) continue;
    out.push({
      name,
      arguments: (entry as { arguments?: unknown }).arguments,
    });
  }
  return out;
}

/**
 * Read a tool's IN-BAND error out of its own output.
 *
 * Not every tool signals failure by throwing. Several report it in the
 * payload instead — `webSearch` returns `{ results: [], error: "Search
 * timed out." }`, and `toSDKTool` itself serializes a thrown tool into
 * `{ error }`. A batch that only watched for exceptions would mark those
 * invocations successful and show a green check above red error text.
 *
 * Only an `error` property typed as a non-empty string counts. We do not
 * sniff string outputs for an "Error:" prefix: the fs tools use that
 * convention, but so could any page's text content, and a false positive
 * here silently discards a real read.
 */
export function readInBandError(output: unknown): string | null {
  if (output === null || typeof output !== "object" || Array.isArray(output)) {
    return null;
  }
  const raw = (output as { error?: unknown }).error;
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Read the `results` array out of a `batch` tool-call output. Returns an
 * empty array for the error-shaped output (`{ error }`) that `toSDKTool`
 * substitutes when the tool itself throws.
 */
export function readBatchResults(output: unknown): BatchInvocationResult[] {
  const raw = (output as { results?: unknown } | null | undefined)?.results;
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (r): r is BatchInvocationResult =>
      typeof (r as { name?: unknown })?.name === "string",
  );
}

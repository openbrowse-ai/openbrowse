import { OPFS } from "../../vfs/opfs";
import { isUploadsPath } from "../../uploads-dir";

/**
 * Per-conversation workspace root in OPFS. Mirrors the convention used by
 * `tools/fs.ts` so files written via `saveAs` show up in the same place
 * `Read` / `executePython` / etc. expect.
 */
function workspaceRoot(conversationId: string): string {
  return `conversations/${conversationId}/workspace`;
}

export interface SaveAsResult {
  ok: true;
  path: string;
  bytes: number;
  sha256: string;
}

export interface SaveAsError {
  ok: false;
  error: string;
}

/**
 * Validate a `saveAs` path. The agent gives us a path that should land
 * somewhere under `/workspace/<conv>`; we strip leading slashes, refuse
 * anything that escapes the workspace root, and refuse writes into the
 * read-only `.uploads/` directory.
 *
 * Returns the resolved OPFS path on success, or an error string on failure.
 */
function resolveSaveAsPath(
  conversationId: string,
  rawPath: string,
): { ok: true; fullPath: string } | { ok: false; error: string } {
  // `rawPath` is enforced as `string` by the Zod schema upstream; we only
  // need to guard against blanks/whitespace here.
  if (!rawPath) {
    return { ok: false, error: "saveAs must be a non-empty string" };
  }
  const trimmed = rawPath.trim();
  if (!trimmed) return { ok: false, error: "saveAs must not be blank" };

  // Reject absolute paths that don't target /workspace. We don't accept
  // /skills/ writes (read-only) or anything else outside the conversation
  // workspace.
  if (trimmed.startsWith("/") && !trimmed.startsWith("/workspace/")) {
    return {
      ok: false,
      error:
        "saveAs path must be relative to /workspace (or start with /workspace/...)",
    };
  }
  // Strip any /workspace/ prefix so paths look identical to what `Write` accepts.
  let rel = trimmed.replace(/^\/+/, "");
  if (rel.startsWith("workspace/")) rel = rel.slice("workspace/".length);
  if (!rel) return { ok: false, error: "saveAs must include a filename" };

  // No `..` traversal. Also reject single-segment `..` inside the path.
  const parts = rel.split("/");
  if (parts.some((p) => p === ".." || p === "")) {
    return {
      ok: false,
      error: "saveAs path must not contain `..` or empty segments",
    };
  }

  if (isUploadsPath(rel)) {
    return {
      ok: false,
      error:
        "saveAs path under /.uploads/ is not allowed (read-only attachment area)",
    };
  }

  return { ok: true, fullPath: `${workspaceRoot(conversationId)}/${rel}` };
}

/**
 * SHA-256 of `bytes`, hex-encoded. Used in tool-result metadata so callers
 * can spot truncated/corrupt writes without re-reading the whole file.
 */
async function sha256Hex(bytes: ArrayBuffer | Uint8Array): Promise<string> {
  // Always digest a fresh ArrayBuffer view to avoid SharedArrayBuffer typing
  // issues from .buffer when bytes is a Uint8Array slice.
  let buf: ArrayBuffer;
  if (bytes instanceof Uint8Array) {
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    buf = copy.buffer;
  } else {
    buf = bytes;
  }
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * The shape we accept from sandbox-side scripts when the caller asks us to
 * persist binary data. CDP's `Runtime.evaluate(returnByValue: true)` only
 * round-trips JSON, so binary has to come back as base64 in this envelope.
 */
function isBinaryEnvelope(
  value: unknown,
): value is { __binary_b64: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    "__binary_b64" in value &&
    typeof (value as { __binary_b64: unknown }).__binary_b64 === "string"
  );
}

function decodeBase64(b64: string): Uint8Array {
  // atob is available in Node ≥16 and browsers; we don't need polyfills.
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Persist a sandbox-script return value to /workspace/<saveAs>.
 *
 * Accepted return shapes (checked in order):
 * - `string` — written as text via `OPFS.writeFileAtomic`.
 * - `{ __binary_b64: string }` — base64-decoded and written via
 *   `OPFS.writeFileBytesAtomic`.
 * - `Uint8Array` / `ArrayBuffer` — written as bytes (executeCode only;
 *   CDP's executeOnPage strips typed-array-ness in transit).
 * - any other JSON-serializable value (object, array, number, boolean,
 *   null) — `JSON.stringify`'d with 2-space indent and written as text.
 *   This is the common case for paginated-scrape results; auto-
 *   serializing here saves the agent from having to remember to
 *   `JSON.stringify` inside the script body (a frequent footgun whose
 *   recovery cost is re-running the entire scrape).
 *
 * Rejected:
 * - `undefined`, `function`, `symbol` — JSON.stringify would yield
 *   `undefined`, which we surface as a script bug.
 * - any value that throws on `JSON.stringify` (circular references,
 *   BigInt) — the error message includes a recovery hint.
 */
export async function persistReturnValue(args: {
  conversationId: string;
  saveAs: string;
  returnValue: unknown;
  /** Where the data is coming from, for error messages. */
  source: "executeOnPage" | "executeCode";
}): Promise<SaveAsResult | SaveAsError> {
  const { conversationId, saveAs, returnValue, source } = args;

  const resolved = resolveSaveAsPath(conversationId, saveAs);
  if (!resolved.ok) return { ok: false, error: resolved.error };
  const { fullPath } = resolved;

  // Strings → text write.
  if (typeof returnValue === "string") {
    await OPFS.writeFileAtomic(fullPath, returnValue);
    const bytes = new TextEncoder().encode(returnValue);
    return {
      ok: true,
      path: stripWorkspacePrefix(conversationId, fullPath),
      bytes: bytes.length,
      sha256: await sha256Hex(bytes),
    };
  }

  // Binary envelope → base64-decode → bytes write.
  if (isBinaryEnvelope(returnValue)) {
    let bytes: Uint8Array;
    try {
      bytes = decodeBase64(returnValue.__binary_b64);
    } catch (e) {
      return {
        ok: false,
        error: `saveAs: __binary_b64 was not valid base64 (${(e as Error).message})`,
      };
    }
    await OPFS.writeFileBytesAtomic(fullPath, bytes);
    return {
      ok: true,
      path: stripWorkspacePrefix(conversationId, fullPath),
      bytes: bytes.length,
      sha256: await sha256Hex(bytes),
    };
  }

  // Direct ArrayBuffer / Uint8Array — only reachable via `executeCode`,
  // whose sandbox uses `postMessage` (structured clone preserves typed
  // arrays). The `executeOnPage` path goes through CDP `Runtime.evaluate`
  // with `returnByValue: true`, which JSON-serializes the result and
  // strips typed-array-ness; for that path callers must use the
  // `__binary_b64` envelope above.
  if (returnValue instanceof Uint8Array) {
    await OPFS.writeFileBytesAtomic(fullPath, returnValue);
    return {
      ok: true,
      path: stripWorkspacePrefix(conversationId, fullPath),
      bytes: returnValue.byteLength,
      sha256: await sha256Hex(returnValue),
    };
  }
  if (returnValue instanceof ArrayBuffer) {
    const view = new Uint8Array(returnValue);
    await OPFS.writeFileBytesAtomic(fullPath, view);
    return {
      ok: true,
      path: stripWorkspacePrefix(conversationId, fullPath),
      bytes: view.byteLength,
      sha256: await sha256Hex(view),
    };
  }

  // Plain JSON-able value (object, array, number, boolean, null) →
  // JSON.stringify with 2-space indent and write as text.
  //
  // The most common saveAs use case is "the script computed a structured
  // result, persist it for later Python-side analysis." The previous
  // contract rejected non-string returns, forcing the agent to call
  // JSON.stringify inside the script body. When it forgot, the script
  // (often a paginated scrape that took 10+ seconds) had to be re-run.
  // Auto-serialization here removes that footgun.
  //
  // Order matters: this branch comes AFTER the binary-envelope and
  // typed-array branches above so binary writes are not accidentally
  // converted to JSON literals like "[object ArrayBuffer]".
  //
  // `null` is `typeof === "object"` in JS, but `JSON.stringify(null)`
  // correctly emits the literal "null", so it flows through fine.
  if (
    returnValue === null ||
    typeof returnValue === "number" ||
    typeof returnValue === "boolean" ||
    typeof returnValue === "object"
  ) {
    let serialized: string | undefined;
    try {
      serialized = JSON.stringify(returnValue, null, 2);
    } catch (e) {
      return {
        ok: false,
        error:
          `saveAs from ${source}: return value could not be JSON-serialized ` +
          `(${(e as Error).message}). Common cause: circular references or ` +
          `BigInt values. Stringify manually inside the script with a ` +
          `custom replacer if needed.`,
      };
    }
    // JSON.stringify returns undefined when the input is purely a value
    // not representable in JSON (function, symbol, undefined). Surface
    // that as a script bug rather than writing the literal string
    // "undefined".
    if (serialized === undefined) {
      return {
        ok: false,
        error:
          `saveAs from ${source}: return value contained a value not ` +
          `representable in JSON (function, undefined, or symbol). ` +
          `Strip those before returning, or wrap them in a serializable ` +
          `shape.`,
      };
    }
    await OPFS.writeFileAtomic(fullPath, serialized);
    const bytes = new TextEncoder().encode(serialized);
    return {
      ok: true,
      path: stripWorkspacePrefix(conversationId, fullPath),
      bytes: bytes.length,
      sha256: await sha256Hex(bytes),
    };
  }

  return {
    ok: false,
    error:
      `saveAs from ${source}: script return value must be a string, ` +
      "JSON-serializable value (object/array/number/boolean/null), or " +
      "{ __binary_b64: string } envelope; got " +
      describeValue(returnValue),
  };
}

function stripWorkspacePrefix(
  conversationId: string,
  fullPath: string,
): string {
  const root = workspaceRoot(conversationId) + "/";
  return fullPath.startsWith(root) ? fullPath.slice(root.length) : fullPath;
}

function describeValue(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return `array(length ${v.length})`;
  return typeof v;
}

// Exposed for tests.
export const _internals = { resolveSaveAsPath, sha256Hex };

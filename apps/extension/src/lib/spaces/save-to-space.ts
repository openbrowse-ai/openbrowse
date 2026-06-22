import { OPFS } from "@/lib/vfs/opfs";
import { savedFilesDb, sha256Hex } from "./saved-files-db";

export interface SaveToSpaceArgs {
  conversationId: string;
  /** Active space id. Empty / falsy → operation is rejected. */
  spaceId: string;
  /**
   * Workspace-relative path within the conversation, e.g. "notes.md" or
   * "sub/dir/data.csv". A leading slash is tolerated.
   */
  filePath: string;
}

/**
 * Outcome of a successful `saveToSpace`. `mode` distinguishes the two paths:
 *   - "created": no prior save record existed; a new copy was written.
 *   - "updated": a prior record existed and pointed at an OPFS file we
 *     overwrote with the latest source bytes (the typical "save again" case
 *     after the source changed).
 */
export type SaveToSpaceResult =
  | { ok: true; savedAt: string; mode: "created" | "updated" }
  | { ok: false; error: string };

/**
 * Promote a file from a conversation's private workspace into the space's
 * shared workspace, recording a (conversationId, filePath) → spaceFilePath
 * relationship in `savedFilesDb`. Subsequent saves of the same source file
 * **overwrite** the existing destination instead of producing
 * Finder-style `(2)`/`(3)` duplicates — the saved-state UI uses the
 * recorded relationship to surface "saved" / "stale" indicators, and a
 * unique-suffix would silently break that contract.
 *
 * Source: `conversations/<conversationId>/workspace/<filePath>`
 * Destination: `spaces/<spaceId>/workspace/<spaceFilePath>` where
 *   `spaceFilePath` matches the recorded one (if any) or `filePath`.
 *
 * The shared space workspace is read-only to the agent (see fs tools); this
 * helper is the explicit user gesture that promotes a file there.
 */
export async function saveToSpace(args: SaveToSpaceArgs): Promise<SaveToSpaceResult> {
  if (!args.conversationId) {
    return { ok: false, error: "Missing conversationId." };
  }
  if (!args.spaceId) {
    return { ok: false, error: "No active space; cannot save." };
  }
  const cleanFilePath = args.filePath.replace(/^\/+/, "");
  if (!cleanFilePath) {
    return { ok: false, error: "Empty file path." };
  }
  const parts = cleanFilePath.split("/");
  if (parts.some((p) => p === ".." || p === "" || p === ".")) {
    return {
      ok: false,
      error: "filePath must not contain `..`, `.`, or empty segments.",
    };
  }
  const source = `conversations/${args.conversationId}/workspace/${cleanFilePath}`;
  if (!(await OPFS.exists(source))) {
    return { ok: false, error: `Source file not found: ${args.filePath}` };
  }

  // Read source bytes once and reuse them for both the OPFS write and the
  // hash computation. Avoids re-reading the file (which can be large) and
  // keeps the size + hash perfectly consistent with what we just wrote.
  let sourceBytes: Blob;
  try {
    sourceBytes = await OPFS.readFileBytes(source);
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }

  // Decide where this save lives in the space. If a prior record exists
  // and still targets this space, reuse its `spaceFilePath` so re-saves
  // overwrite the same file (no `(2)` / `(3)` duplicates). Otherwise
  // default to the conversation's relative path.
  const priorRecord = await savedFilesDb.get(args.conversationId, cleanFilePath);
  const reuseExisting =
    priorRecord != null && priorRecord.spaceId === args.spaceId;
  const spaceFilePath = reuseExisting
    ? priorRecord.spaceFilePath
    : cleanFilePath;
  const dest = `spaces/${args.spaceId}/workspace/${spaceFilePath}`;

  try {
    await OPFS.writeFileBytes(dest, sourceBytes);
    const sourceHashHex = await sha256Hex(sourceBytes);
    await savedFilesDb.recordSave({
      conversationId: args.conversationId,
      filePath: cleanFilePath,
      spaceId: args.spaceId,
      spaceFilePath,
      savedAt: Date.now(),
      sourceSize: sourceBytes.size,
      sourceHashHex,
    });
    return {
      ok: true,
      savedAt: dest,
      mode: reuseExisting ? "updated" : "created",
    };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

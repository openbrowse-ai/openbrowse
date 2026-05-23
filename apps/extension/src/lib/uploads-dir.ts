/**
 * Subdirectory under each conversation's OPFS workspace that holds files
 * the user attached via the chat input. Kept separate from agent-written
 * files so:
 *
 *   - The Working Folder rail can hide them (it lists agent output only).
 *   - The agent's `fs` tool can refuse mutations against this prefix
 *     (read is allowed; write/edit is denied), keeping user inputs
 *     immutable.
 *
 * The leading dot signals "system-managed" and reduces the chance the
 * agent ever tries to put its own output here.
 */
export const UPLOADS_DIR = ".uploads";

/**
 * True when `rawPath` (workspace-relative, with or without leading `/`)
 * targets the uploads subtree. Used to gate agent mutations.
 */
export function isUploadsPath(rawPath: string): boolean {
  const clean = rawPath.replace(/^\/+/, "");
  return clean === UPLOADS_DIR || clean.startsWith(`${UPLOADS_DIR}/`);
}

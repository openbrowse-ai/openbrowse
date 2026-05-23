import { createContext, useContext } from "react";

/**
 * Workspace-relative file path (no leading slash). Examples: `notes.csv`,
 * `subdir/data.csv`. The receiver maps this onto the active conversation's
 * OPFS workspace via `conversations/{conversationId}/workspace/{path}`.
 */
export type FileSelectionHandler = (relativePath: string) => void;

/**
 * Lets descendant components (chat messages, tool result chips, attachment
 * cards) request that the right-rail file viewer open a workspace file. The
 * provider lives at the home App level next to the rail itself, so a click
 * anywhere in the conversation pane can drive `handleSelectFile`.
 *
 * `null` is the legitimate fallback when no provider is mounted (e.g. in
 * isolated tests or settings previews); consumers should treat `null` as
 * "no-op" rather than throwing.
 */
export const FileSelectionContext =
  createContext<FileSelectionHandler | null>(null);

/** Read the current handler. Returns `null` outside any provider. */
export function useFileSelection(): FileSelectionHandler | null {
  return useContext(FileSelectionContext);
}

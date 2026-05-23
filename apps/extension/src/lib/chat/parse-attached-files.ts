/**
 * Parser for the `<Attached files>` block emitted by `formatAttachments`.
 *
 * Producer: `apps/extension/src/lib/chat/format-attachments.ts`.
 * Consumer: `apps/extension/src/components/chat/UserMessage.tsx`.
 *
 * Round-trip is exercised in `__tests__/parse-attached-files.test.ts` so
 * the producer and consumer stay in lock-step if the format ever evolves.
 */

const OPEN = "\n\n<Attached files>\n";
const CLOSE = "</Attached files>";

export interface ParsedAttachedFiles {
  /** The original text with the `<Attached files>` block stripped. */
  displayText: string;
  /** Workspace-relative paths the block listed (with leading `/`). */
  attachedPaths: string[];
}

/**
 * Strip the trailing `<Attached files>` block from `text` (if any) and
 * return the resulting display text plus the list of paths the block
 * referenced.
 *
 * If the block is absent or malformed (no closing tag), `text` is
 * returned unchanged with an empty path list.
 *
 * `lastIndexOf` for the opener is intentional: a user-typed
 * `<Attached files>` literal earlier in the prompt is preserved in
 * `displayText`; only the trailing block (the one `formatAttachments`
 * appended) is parsed.
 */
export function parseAttachedFiles(text: string): ParsedAttachedFiles {
  const start = text.lastIndexOf(OPEN);
  if (start === -1) return { displayText: text, attachedPaths: [] };

  const end = text.indexOf(CLOSE, start);
  if (end === -1) return { displayText: text, attachedPaths: [] };

  const blockBody = text.slice(start + OPEN.length, end);
  const paths = blockBody
    .split("\n")
    .map((line) => line.replace(/^- /, "").trim())
    .filter((p) => p.length > 0);

  return { displayText: text.slice(0, start), attachedPaths: paths };
}

import type { JSONContent } from "@tiptap/core";
import { isBuiltinSlashCommand } from "./slash-commands";

/**
 * Pure JSONContent traversal helpers for built-in slash commands.
 *
 * Kept separate from `ChatInput.tsx` so they can be unit-tested without
 * pulling in tiptap/react and the rest of the composer's heavy deps.
 * Mirrors the shape of `extractTabMentions` in ChatInput.
 *
 * A built-in command is a `skillSlash` node whose `attrs.name` matches a
 * registered command (see `slash-commands.ts`). Skills use the same node
 * type, so we discriminate purely on the name.
 */

function slashNodeName(node: JSONContent): string | null {
  if (node.type !== "skillSlash") return null;
  const name = node.attrs?.name ?? node.attrs?.label ?? node.attrs?.id;
  return typeof name === "string" ? name : null;
}

/**
 * Collect the names of built-in command nodes present in the doc, in
 * document order. Non-command skill slashes, tab mentions and text are
 * ignored.
 */
export function extractSlashCommands(json: JSONContent): string[] {
  const commands: string[] = [];

  function traverse(node: JSONContent) {
    const name = slashNodeName(node);
    if (name && isBuiltinSlashCommand(name)) {
      commands.push(name);
    }
    if (node.content) {
      for (const child of node.content) traverse(child);
    }
  }

  traverse(json);
  return commands;
}

export interface StripSlashCommandsResult {
  /** A deep copy of the doc with built-in command nodes removed. */
  json: JSONContent;
  /**
   * True when, after removing built-in command nodes, the doc still has
   * meaningful content (non-whitespace text, a tab mention, or a
   * non-command skill slash). When false, the message was *only* the
   * command(s) and nothing should be sent to the agent.
   */
  hasRemaining: boolean;
}

/**
 * Remove built-in command nodes from the doc and report whether any
 * sendable content remains. Does not mutate the input.
 */
export function stripSlashCommandNodes(
  json: JSONContent,
): StripSlashCommandsResult {
  let hasRemaining = false;

  function clone(node: JSONContent): JSONContent | null {
    const name = slashNodeName(node);
    if (name && isBuiltinSlashCommand(name)) {
      // Drop the command node entirely.
      return null;
    }

    // Leaf accounting: any non-whitespace text or any mention/other node
    // counts as remaining content worth sending.
    if (node.type === "text") {
      if ((node.text ?? "").trim().length > 0) hasRemaining = true;
    } else if (node.type === "tabMention" || node.type === "skillSlash") {
      hasRemaining = true;
    }

    const next: JSONContent = { ...node };
    if (node.content) {
      const children: JSONContent[] = [];
      for (const child of node.content) {
        const c = clone(child);
        if (c) children.push(c);
      }
      next.content = children;
    }
    return next;
  }

  const cloned = clone(json) ?? { type: json.type ?? "doc", content: [] };
  return { json: cloned, hasRemaining };
}

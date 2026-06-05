/**
 * Built-in slash commands surfaced in the chat composer's "/" popup,
 * alongside user skills. Unlike skills (which serialise to `/name` text
 * the agent interprets), built-in commands are intercepted locally at
 * submit time and trigger a client-side action (e.g. `/compact` runs a
 * manual conversation compaction).
 *
 * A command shares the same `/name` syntax and the same `skillSlash`
 * tiptap node as a skill; the only difference is that `ChatInput`
 * recognises the name via `isBuiltinSlashCommand` and routes it to the
 * host's `onCommand` handler instead of sending it as message text.
 */
export interface BuiltinSlashCommand {
  /** Command name as typed after the slash, e.g. "compact". Lowercase. */
  name: string;
  /** Short description shown in the popup's secondary line. */
  description: string;
}

export const BUILTIN_SLASH_COMMANDS: readonly BuiltinSlashCommand[] = [
  {
    name: "compact",
    description: "Summarize the conversation so far to free up context",
  },
];

const BUILTIN_NAMES = new Set(BUILTIN_SLASH_COMMANDS.map((c) => c.name));

/** True when `name` is a known built-in command (exact, lowercase match). */
export function isBuiltinSlashCommand(name: string): boolean {
  return BUILTIN_NAMES.has(name);
}

/**
 * Filter built-in commands for the slash popup. Matches the query against
 * both the command name and its description, case-insensitively. An empty
 * query returns all commands.
 */
export function matchBuiltinCommands(query: string): BuiltinSlashCommand[] {
  const q = query.toLowerCase();
  if (!q) return [...BUILTIN_SLASH_COMMANDS];
  return BUILTIN_SLASH_COMMANDS.filter(
    (c) =>
      c.name.toLowerCase().includes(q) ||
      c.description.toLowerCase().includes(q),
  );
}

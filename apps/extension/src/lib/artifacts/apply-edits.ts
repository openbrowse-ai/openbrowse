export interface ArtifactEdit {
  find: string;
  replace: string;
}

/**
 * Apply a sequence of exact find/replace edits to a source string.
 *
 * Each edit's `find` must occur EXACTLY ONCE in the current text (after all
 * prior edits have been applied). This makes edits unambiguous and lets the
 * caller surface a precise, correctable error when a snippet is missing or not
 * unique — far cheaper than re-emitting the entire artifact HTML on every
 * change.
 *
 * Throws on: empty edit list, an empty `find`, zero matches, or multiple
 * matches. The error names the 1-based edit index and includes a short excerpt
 * so the agent can fix the offending edit.
 */
export function applyEdits(source: string, edits: ArtifactEdit[]): string {
  if (edits.length === 0) {
    throw new Error("edits must contain at least one { find, replace }");
  }
  let text = source;
  edits.forEach((edit, i) => {
    const n = i + 1;
    if (edit.find.length === 0) {
      throw new Error(`edit #${n}: 'find' must not be empty`);
    }
    const count = countOccurrences(text, edit.find);
    if (count === 0) {
      throw new Error(`edit #${n}: 'find' not found: ${excerpt(edit.find)}`);
    }
    if (count > 1) {
      throw new Error(
        `edit #${n}: 'find' matched ${count} times (must be unique): ${excerpt(edit.find)}`,
      );
    }
    // Use a function replacement so `$`-sequences in `replace` are inserted
    // literally (string replacement would interpret $&, $1, etc.).
    text = text.replace(edit.find, () => edit.replace);
  });
  return text;
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let from = 0;
  for (;;) {
    const idx = haystack.indexOf(needle, from);
    if (idx === -1) break;
    count++;
    from = idx + needle.length;
  }
  return count;
}

function excerpt(s: string, max = 80): string {
  const oneLine = s.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}

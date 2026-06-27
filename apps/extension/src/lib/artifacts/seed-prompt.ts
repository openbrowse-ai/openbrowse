import type { ArtifactError } from "./rpc";

/**
 * Wrap runtime-provided text in a fenced code block whose fence is longer than
 * any backtick run inside `body`, so untrusted diagnostics (stacks, console
 * output) can't break out of the fence and inject prompt instructions.
 */
function fence(body: string): string {
  const longestRun = (body.match(/`+/g) ?? []).reduce(
    (n, s) => Math.max(n, s.length),
    0,
  );
  const ticks = "`".repeat(Math.max(3, longestRun + 1));
  return `${ticks}\n${body}\n${ticks}`;
}

/**
 * Build the chat message used by the artifact's "Fix with OpenBrowse" banner.
 * Pure (no I/O) so the wording is unit-testable. The agent already receives
 * the artifact's full HTML as standing context, so this only needs to convey
 * the error and any diagnostic breadcrumbs.
 *
 * All runtime-provided fields (message/sourceFile/stack/recentConsole) are
 * treated as untrusted: multi-line text is kept inside its block (blockquote or
 * fence) and code blocks use a backtick-safe fence so the artifact can't escape
 * the markdown to steer the agent.
 */
export function buildErrorFixPrompt(
  artifactTitle: string,
  error: ArtifactError,
): string {
  const lines: string[] = [];
  lines.push(`The "${artifactTitle}" artifact is failing with this error:`);
  lines.push("");
  // Prefix every line so an embedded newline can't escape the blockquote.
  for (const ln of error.message.split("\n")) lines.push(`> ${ln}`);

  if (error.sourceFile) {
    lines.push("");
    for (const ln of `Location: ${error.sourceFile}`.split("\n")) lines.push(ln);
  }

  if (error.stack) {
    lines.push("");
    lines.push("Stack:");
    lines.push(fence(error.stack));
  }

  if (error.recentConsole && error.recentConsole.length > 0) {
    lines.push("");
    lines.push("Recent console output:");
    lines.push(fence(error.recentConsole.join("\n")));
  }

  lines.push("");
  lines.push("Please diagnose the root cause and fix the artifact.");
  return lines.join("\n");
}

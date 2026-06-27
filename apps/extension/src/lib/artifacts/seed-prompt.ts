import type { ArtifactError } from "./rpc";

/**
 * Build the chat message used by the artifact's "Fix with OpenBrowse" banner.
 * Pure (no I/O) so the wording is unit-testable. The agent already receives
 * the artifact's full HTML as standing context, so this only needs to convey
 * the error and any diagnostic breadcrumbs.
 */
export function buildErrorFixPrompt(
  artifactTitle: string,
  error: ArtifactError,
): string {
  const lines: string[] = [];
  lines.push(`The "${artifactTitle}" artifact is failing with this error:`);
  lines.push("");
  lines.push(`> ${error.message}`);

  if (error.sourceFile) {
    lines.push("");
    lines.push(`Location: ${error.sourceFile}`);
  }

  if (error.stack) {
    lines.push("");
    lines.push("Stack:");
    lines.push("```");
    lines.push(error.stack);
    lines.push("```");
  }

  if (error.recentConsole && error.recentConsole.length > 0) {
    lines.push("");
    lines.push("Recent console output:");
    lines.push("```");
    lines.push(error.recentConsole.join("\n"));
    lines.push("```");
  }

  lines.push("");
  lines.push("Please diagnose the root cause and fix the artifact.");
  return lines.join("\n");
}

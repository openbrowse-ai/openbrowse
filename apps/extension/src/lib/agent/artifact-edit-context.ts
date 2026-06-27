import type { SavedArtifact } from "@/lib/artifacts/registry";

/**
 * Build the standing "### Editing Artifact" system-prompt block injected when a
 * conversation is tagged with `editingArtifactId`. Kept pure (no I/O) so the
 * exact wording — which steers the agent away from filesystem lookups and
 * toward `update_artifact({ edits })` — is unit-testable.
 */
export function buildEditingArtifactBlock(a: SavedArtifact): string {
  let block = `\n\n### Editing Artifact\n`;
  block += `The user is editing an existing artifact. Its complete current HTML is provided below — this is your source of truth.\n`;
  block += `Do NOT use Read, Glob, LS, navigate, or any filesystem/browser tool to find the artifact; it is not on disk in this conversation. Edit the HTML below directly.\n`;
  block += `To apply changes, call \`update_artifact({ id: "${a.manifest.id}", edits: [{ find, replace }] })\` with small find/replace edits — each \`find\` must occur exactly once in the HTML below. Do NOT re-send the whole file. Preserve the existing structure unless asked otherwise.\n`;
  block += `Title: ${a.manifest.title}\n`;
  block += `Manifest tools: ${JSON.stringify(a.manifest.tools)}\n`;
  if (a.manifest.cdns?.length) block += `CDNs: ${JSON.stringify(a.manifest.cdns)}\n`;
  if (a.manifest.network?.length) block += `Network: ${JSON.stringify(a.manifest.network)}\n`;
  block += `\nCurrent HTML:\n\`\`\`html\n${a.html}\n\`\`\`\n`;
  return block;
}

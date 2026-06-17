import { OPFS } from "../vfs/opfs";

/**
 * Read a `kind: "site"` skill's bundled page script by reference. Scripts live
 * at `skills/<skill>/<script>` (the same OPFS tree the Skills UI shows).
 * Returns null when the file is missing/invalid. The body is loaded here so it
 * never has to enter the agent's context (run-by-reference).
 */
export async function readSiteSkillScript(
  skill: string,
  script: string,
): Promise<string | null> {
  // Confine to a single skill dir; reject traversal / nested paths.
  if (!skill || /[\\/]|\.\./.test(skill)) return null;
  const rel = script.replace(/^\/+/, "");
  if (rel.includes("..")) return null;
  try {
    return await OPFS.readFile(`skills/${skill}/${rel}`);
  } catch {
    return null;
  }
}

/**
 * Extract a script's `// @desc ...` first-line summary, or null when absent.
 * Mirrors the convention used in the site skill's SKILL.md script catalog.
 */
export function parseScriptDesc(body: string): string | null {
  const firstLine = body.split("\n", 1)[0] ?? "";
  const m = firstLine.match(/^\s*\/\/\s*@desc\s+(.+?)\s*$/);
  return m ? m[1] : null;
}

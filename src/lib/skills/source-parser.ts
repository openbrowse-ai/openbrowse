/**
 * Parses user input into a canonical skill source.
 */

export type ParsedSource = 
  | { kind: "github"; owner: string; repo: string; ref?: string; subpath?: string }
  | { kind: "raw-skill-md"; url: string }
  | { kind: "invalid"; reason: string };

export function parseSource(input: string): ParsedSource {
  const trimmed = input.trim().split(" ")[0]; // Clean off any appended text like " --skill name"
  
  if (!trimmed) {
    return { kind: "invalid", reason: "Source cannot be empty" };
  }

  // 1. github: shorthand (github:owner/repo[/path])
  if (trimmed.startsWith("github:")) {
    const parts = trimmed.slice(7).split("/");
    if (parts.length < 2) {
      return { kind: "invalid", reason: "Invalid github: shorthand. Expected github:owner/repo" };
    }
    const owner = parts[0];
    const repo = parts[1];
    const subpath = parts.length > 2 ? parts.slice(2).join("/") : undefined;
    
    return { kind: "github", owner, repo, subpath };
  }

  // 2. raw.githubusercontent URL
  if (trimmed.startsWith("https://raw.githubusercontent.com/") && trimmed.endsWith("SKILL.md")) {
    return { kind: "raw-skill-md", url: trimmed };
  }

  // 3. https://github.com/owner/repo
  if (trimmed.startsWith("https://github.com/")) {
    try {
      const url = new URL(trimmed);
      const parts = url.pathname.replace(/^\//, '').split('/');
      
      if (parts.length < 2) {
        return { kind: "invalid", reason: "Invalid GitHub URL. Expected https://github.com/owner/repo" };
      }

      const owner = parts[0];
      const repo = parts[1];
      
      // https://github.com/owner/repo/tree/main/path/to/skill
      if (parts.length >= 4 && parts[2] === 'tree') {
        const ref = parts[3];
        const subpath = parts.slice(4).join('/');
        return { kind: "github", owner, repo, ref, subpath: subpath || undefined };
      }

      return { kind: "github", owner, repo };
    } catch (e) {
      return { kind: "invalid", reason: "Invalid URL format" };
    }
  }

  return { kind: "invalid", reason: "Unrecognized source format. Use github:owner/repo or a GitHub URL." };
}

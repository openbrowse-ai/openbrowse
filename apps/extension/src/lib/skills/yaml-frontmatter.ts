/**
 * Minimal YAML frontmatter parser for SKILL.md files.
 * Designed to extract standard Agentskills.io metadata without a heavy dependency.
 */

export interface SkillFrontmatter {
  name: string;
  description: string;
  [key: string]: unknown;
}

export function parseSkillFrontmatter(content: string): { frontmatter: SkillFrontmatter; body: string } {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  
  if (!match) {
    throw new Error("Missing or malformed YAML frontmatter (must start with ---)");
  }

  const yamlRaw = match[1];
  const body = match[2];
  
  const frontmatter: Record<string, unknown> = {};
  const lines = yamlRaw.split(/\r?\n/);
  
  let currentKey = "";
  let currentValue = "";

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '' || line.trim().startsWith('#')) continue;
    
    // Check if this is a continuation line (indented)
    if (line.startsWith(' ') || line.startsWith('\t')) {
      if (currentKey) {
        currentValue += (currentValue ? ' ' : '') + line.trim();
        frontmatter[currentKey] = currentValue.replace(/^["']|["']$/g, '');
      }
      continue;
    }

    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue; // Skip malformed lines
    
    currentKey = line.slice(0, colonIdx).trim();
    currentValue = line.slice(colonIdx + 1).trim();
    
    // Strip surrounding quotes if present
    frontmatter[currentKey] = currentValue.replace(/^["']|["']$/g, '');
  }

  // Final cleanup of quotes from potentially concatenated lines
  for (const [key, value] of Object.entries(frontmatter)) {
    if (typeof value === "string") {
      frontmatter[key] = value.replace(/^["']|["']$/g, '').trim();
    }
  }

  // Validation
  if (typeof frontmatter.name !== 'string' || !frontmatter.name) {
    throw new Error("Skill frontmatter must include a 'name' field");
  }
  
  if (!/^[a-z0-9-]+$/.test(frontmatter.name)) {
    throw new Error("Skill name must contain only lowercase letters, numbers, and hyphens");
  }

  if (frontmatter.name.length > 64) {
    throw new Error("Skill name must be 64 characters or less");
  }

  if (typeof frontmatter.description !== 'string' || !frontmatter.description) {
    throw new Error("Skill frontmatter must include a 'description' field");
  }

  if (frontmatter.description.length > 1024) {
    throw new Error("Skill description must be 1024 characters or less");
  }

  return {
    frontmatter: frontmatter as unknown as SkillFrontmatter,
    body
  };
}

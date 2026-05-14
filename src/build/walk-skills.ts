import path from "node:path";
import fs from "node:fs";

export function walkSkills(dir: string, baseDir = dir): { name: string; files: string[] }[] {
  const result: { name: string; files: string[] }[] = [];
  
  // A skill is a folder containing a SKILL.md file.
  // The first level of subdirectories under public/skills/ are the skill names.
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  
  for (const entry of entries) {
    if (entry.isDirectory()) {
      const skillName = entry.name;
      const skillPath = path.join(dir, skillName);
      const skillMdPath = path.join(skillPath, "SKILL.md");
      
      if (fs.existsSync(skillMdPath)) {
        const files: string[] = [];
        
        // Recursively find all files in the skill directory
        function walk(currentDir: string) {
          const subEntries = fs.readdirSync(currentDir, { withFileTypes: true });
          for (const sub of subEntries) {
            const subPath = path.join(currentDir, sub.name);
            if (sub.isDirectory()) {
              walk(subPath);
            } else {
              // Store relative path from the skill root
              const relativePath = path.relative(skillPath, subPath);
              files.push(relativePath.replace(/\\/g, '/'));
            }
          }
        }
        
        walk(skillPath);
        result.push({ name: skillName, files });
      }
    }
  }
  
  return result;
}

import { skillsDb } from "./skills-db";
import { writeOpfsFile, opfsFileExists } from "./opfs";
import { parseSkillFrontmatter } from "./yaml-frontmatter";
import type { InstalledSkill } from "./types";

interface BundledSkillManifest {
  name: string;
  files: string[];
}

export async function bootstrapBundledSkills(): Promise<void> {
  try {
    const manifestUrl = chrome.runtime.getURL("skills-manifest.json");
    const response = await fetch(manifestUrl);
    if (!response.ok) {
      if (response.status === 404) return; // No bundled skills
      throw new Error(`Failed to load skills-manifest.json: ${response.statusText}`);
    }

    const manifest: BundledSkillManifest[] = await response.json();
    if (!manifest || manifest.length === 0) return;

    for (const bundledSkill of manifest) {
      // Check if already installed
      const existing = await skillsDb.get(bundledSkill.name);
      if (existing) continue;

      // Ensure SKILL.md exists in the bundle
      const skillMdUrl = chrome.runtime.getURL(`skills/${bundledSkill.name}/SKILL.md`);
      const skillMdResponse = await fetch(skillMdUrl);
      if (!skillMdResponse.ok) continue;
      
      const skillMdContent = await skillMdResponse.text();
      let frontmatter;
      try {
        const parsed = parseSkillFrontmatter(skillMdContent);
        frontmatter = parsed.frontmatter;
      } catch (e) {
        console.warn(`Failed to parse bundled skill ${bundledSkill.name}:`, e);
        continue;
      }

      // Determine scripts
      const scriptFiles = bundledSkill.files.filter((f: string) => f.startsWith("scripts/"));
      const SCRIPT_EXTENSIONS = [".sh", ".py", ".rb", ".ps1", ".bat"];
      const scriptTypes = Array.from(new Set(
        scriptFiles.map((f: string) => {
          const ext = f.substring(f.lastIndexOf("."));
          return SCRIPT_EXTENSIONS.includes(ext) ? ext.slice(1) : "unknown";
        }).filter(t => t !== "unknown")
      ));

      // Copy all files to OPFS
      for (const file of bundledSkill.files) {
        const fileUrl = chrome.runtime.getURL(`skills/${bundledSkill.name}/${file}`);
        const fileResponse = await fetch(fileUrl);
        if (!fileResponse.ok) continue;
        const blob = await fileResponse.blob();
        await writeOpfsFile(`skills/${bundledSkill.name}/${file}`, blob);
      }

      // Add to database
      const installedSkill: InstalledSkill = {
        name: frontmatter.name,
        description: frontmatter.description,
        source: "bundled",
        metadata: frontmatter,
        hasScripts: scriptFiles.length > 0,
        scriptTypes,
        fileIndex: bundledSkill.files,
        installedAt: Date.now(),
      };

      await skillsDb.save(installedSkill);
    }
  } catch (err) {
    console.error("Failed to bootstrap bundled skills:", err);
  }
}

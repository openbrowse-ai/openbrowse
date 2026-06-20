import { OPFS } from "../vfs/opfs";
import { skillsDb } from "./skills-db";
import { parseSource } from "./source-parser";
import type { InstalledSkill } from "./types";
import { parseSkillFrontmatter } from "./yaml-frontmatter";

/**
 * Normalize a script-relative path and reject any attempt to escape the
 * skill directory.
 *
 * The previous implementation was `input.replace(/^\/+/, "").replace(/\.\.\//g, "")`,
 * a single-pass character-class strip that CodeQL flagged as
 * "Incomplete multi-character sanitization" (rule js/incomplete-sanitization,
 * GHSA pattern matched). The bug: a single regex pass over `....//x`
 * matches the first `../`, removes it, and leaves `../x` standing — the
 * very thing the strip was trying to prevent. Same shape as the classic
 * `<scrip<script>t>` pattern in HTML sanitizers.
 *
 * This helper splits the input into segments, drops `.` and empty
 * segments, and throws on any `..` segment (rather than silently
 * stripping or collapsing). The agent gets a clean error and learns;
 * silent stripping would mean its requested path differs from what gets
 * written, which is harder to debug.
 *
 * Examples:
 *   safeRelPath("foo/bar.js")     → "foo/bar.js"
 *   safeRelPath("/foo/bar.js")    → "foo/bar.js"
 *   safeRelPath("./foo")          → "foo"
 *   safeRelPath("../etc/passwd")  → throws
 *   safeRelPath("....//etc")      → throws (segment "..")
 *   safeRelPath("foo/../bar")     → throws (any `..` is rejected)
 *
 * Throws a descriptive Error so the patchSiteSkill / upsertSiteSkill
 * callers can surface it to the agent directly.
 */
function safeRelPath(input: string): string {
  const parts = input.split("/").filter((p) => p.length > 0 && p !== ".");
  for (const p of parts) {
    if (p === "..") {
      throw new Error(
        `Path traversal not allowed: "${input}". Script paths must stay within the skill directory.`,
      );
    }
  }
  return parts.join("/");
}

export interface SkillPreview {
  name: string;
  description: string;
  hasScripts: boolean;
  scriptTypes: string[];
  filePaths: string[]; // Paths relative to the skill root
  downloadUrls: Record<string, string>; // Path -> Download URL
  source: string;
  metadata: Record<string, unknown>;
}

const STANDARD_SKILL_PATHS = [
  "", // root
  "skills",
  "skills/.curated",
  "skills/.experimental",
  "skills/.system",
  ".agents/skills",
  ".claude/skills",
  "plugins", // anthropics/claude-plugins-official uses this
];

const SCRIPT_EXTENSIONS = [".sh", ".py", ".rb", ".ps1", ".bat"];

async function fetchJson(url: string, token?: string) {
  const headers: Record<string, string> = {};
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const res = await fetch(url, { headers });
  if (!res.ok) {
    if (
      res.status === 403 &&
      res.headers.get("x-ratelimit-remaining") === "0"
    ) {
      throw new Error(
        "GitHub API rate limit exceeded. Please add a GitHub token in Settings or try again later.",
      );
    }
    const statusText = res.statusText || `HTTP ${res.status}`;
    throw new Error(`Failed to fetch ${url}: ${statusText}`);
  }
  return res.json();
}

async function fetchText(url: string, token?: string) {
  const headers: Record<string, string> = {};
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const res = await fetch(url, { headers });
  if (!res.ok) {
    const statusText = res.statusText || `HTTP ${res.status}`;
    throw new Error(`Failed to fetch ${url}: ${statusText}`);
  }
  return res.text();
}

/**
 * Scans a parsed source and finds all installable skills.
 */
export async function discoverSkills(
  sourceInput: string,
  githubToken?: string,
): Promise<SkillPreview[]> {
  const parsed = parseSource(sourceInput);
  if (parsed.kind === "invalid") {
    throw new Error(parsed.reason);
  }

  if (parsed.kind === "raw-skill-md") {
    // Single file download
    const content = await fetchText(parsed.url, githubToken);
    const { frontmatter } = parseSkillFrontmatter(content);

    return [
      {
        name: frontmatter.name,
        description: frontmatter.description,
        hasScripts: false,
        scriptTypes: [],
        filePaths: ["SKILL.md"],
        downloadUrls: { "SKILL.md": parsed.url },
        source: parsed.url,
        metadata: frontmatter,
      },
    ];
  }

  // GitHub repo flow
  const { owner, repo, ref, subpath } = parsed;

  // 1. Resolve default branch if no ref
  let resolvedRef = ref;
  if (!resolvedRef) {
    const repoInfo = await fetchJson(
      `https://api.github.com/repos/${owner}/${repo}`,
      githubToken,
    );
    resolvedRef = repoInfo.default_branch;
  }

  // 2. Fetch full tree
  const treeUrl = `https://api.github.com/repos/${owner}/${repo}/git/trees/${resolvedRef}?recursive=1`;
  const treeData = await fetchJson(treeUrl, githubToken);

  // 3. Find all files (exclude directories)
  const allFiles = treeData.tree
    .filter((node: any) => node.type === "blob")
    .map((node: any) => node.path) as string[];
  const skillPaths = allFiles.filter((p) => p.endsWith("SKILL.md"));

  // 4. Filter to search paths (or exact subpath if specified)
  const validSkillRoots = skillPaths
    .map((p) => p.slice(0, -9))
    .filter((root) => {
      // -9 to remove "SKILL.md"
      const normalizedRoot = root.replace(/\/$/, "");
      if (subpath) {
        return (
          normalizedRoot === subpath || normalizedRoot.startsWith(subpath + "/")
        );
      }
      // If no subpath specified, match any path that is reasonably a skill directory
      // (either in standard paths, or under any 'skills' or 'plugins' subdirectory)
      const parentDir = normalizedRoot.includes("/")
        ? normalizedRoot.split("/").slice(0, -1).join("/")
        : "";
      if (
        STANDARD_SKILL_PATHS.includes(parentDir) ||
        parentDir === normalizedRoot ||
        STANDARD_SKILL_PATHS.includes(normalizedRoot)
      ) {
        return true;
      }
      return (
        normalizedRoot.includes("/skills/") ||
        normalizedRoot.startsWith("skills/") ||
        normalizedRoot.startsWith("plugins/")
      );
    });

  const previews: SkillPreview[] = [];

  for (const root of validSkillRoots) {
    const rootPrefix = root ? `${root}/` : "";

    // Find all files belonging to this skill (siblings in the same directory or subdirectories)
    const skillFiles = allFiles.filter(
      (p) => p.startsWith(rootPrefix) && p !== rootPrefix.slice(0, -1),
    );

    // Download SKILL.md to parse frontmatter
    const skillMdPath = root ? `${root}/SKILL.md` : "SKILL.md";
    const rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${resolvedRef}/${skillMdPath}`;
    const content = await fetchText(rawUrl, githubToken);

    let frontmatter;
    try {
      const parsedYaml = parseSkillFrontmatter(content);
      frontmatter = parsedYaml.frontmatter;
    } catch (e) {
      console.warn(`Skipping skill at ${skillMdPath}: ${(e as Error).message}`);
      continue;
    }

    // Determine scripts
    const relativeFiles = skillFiles.map((p) =>
      root ? p.slice(rootPrefix.length) : p,
    );
    const scriptFiles = relativeFiles.filter((p) => p.startsWith("scripts/"));

    const scriptTypes = Array.from(
      new Set(
        scriptFiles
          .map((f) => {
            const ext = f.substring(f.lastIndexOf("."));
            return SCRIPT_EXTENSIONS.includes(ext) ? ext.slice(1) : "unknown";
          })
          .filter((t) => t !== "unknown"),
      ),
    );

    const downloadUrls: Record<string, string> = {};
    for (const file of relativeFiles) {
      const fullPath = rootPrefix ? `${rootPrefix}${file}` : file;
      downloadUrls[file] =
        `https://raw.githubusercontent.com/${owner}/${repo}/${resolvedRef}/${fullPath}`;
    }

    previews.push({
      name: frontmatter.name,
      description: frontmatter.description,
      hasScripts: scriptFiles.length > 0,
      scriptTypes,
      filePaths: relativeFiles,
      downloadUrls,
      source: sourceInput,
      metadata: frontmatter,
    });
  }

  if (previews.length === 0) {
    throw new Error(
      `No valid skills found at ${sourceInput}. Checked standard paths and subpaths.`,
    );
  }

  return previews;
}

/**
 * Downloads and writes a skill to OPFS, and saves it to the database.
 */
export async function installSkill(
  preview: SkillPreview,
  githubToken?: string,
): Promise<InstalledSkill> {
  // Clear any existing directory first
  await OPFS.rm(`skills/${preview.name}`, { recursive: true });

  // Download and write all files
  for (const [relativePath, url] of Object.entries(preview.downloadUrls)) {
    const content = await fetchText(url, githubToken);
    await OPFS.writeFile(`skills/${preview.name}/${relativePath}`, content);
  }

  const installedSkill: InstalledSkill = {
    name: preview.name,
    description: preview.description,
    source: preview.source,
    metadata: preview.metadata,
    kind: preview.metadata.kind === "site" ? "site" : "regular",
    hasScripts: preview.hasScripts,
    scriptTypes: preview.scriptTypes,
    fileIndex: preview.filePaths,
    installedAt: Date.now(),
  };

  await skillsDb.save(installedSkill);
  return installedSkill;
}

/**
 * Creates and installs a skill locally from string content.
 */
export async function createSkillLocally(
  name: string,
  description: string,
  body: string,
  references?: { path: string; content: string }[],
): Promise<InstalledSkill> {
  await OPFS.rm(`skills/${name}`, { recursive: true });

  const frontmatter = `---\nname: ${name}\ndescription: ${description}\n---\n`;
  const fullContent = frontmatter + body;

  const filePaths = ["SKILL.md"];
  await OPFS.writeFile(`skills/${name}/SKILL.md`, fullContent);

  if (references) {
    for (const ref of references) {
      await OPFS.writeFile(`skills/${name}/${ref.path}`, ref.content);
      filePaths.push(ref.path);
    }
  }

  const installedSkill: InstalledSkill = {
    name,
    description,
    source: "local-draft",
    metadata: { name, description },
    hasScripts: false,
    scriptTypes: [],
    fileIndex: filePaths,
    installedAt: Date.now(),
  };

  await skillsDb.save(installedSkill);
  return installedSkill;
}

/**
 * Removes a skill from OPFS and the database.
 */
export async function uninstallSkill(name: string): Promise<void> {
  await OPFS.rm(`skills/${name}`, { recursive: true });
  await skillsDb.delete(name);
}

const SCRIPT_EXT_TO_TYPE: Record<string, string> = {
  ".js": "javascript",
  ".sh": "bash",
  ".py": "python",
  ".rb": "ruby",
};

/**
 * Create or fully overwrite a `kind: "site"` skill (the agent's per-domain,
 * no-approval reusable-script store). `name` is the registrable domain
 * (e.g. "linkedin.com"). Writes `SKILL.md` (with `kind: site` frontmatter)
 * plus any page-script files under the skill directory, then indexes them in
 * the DB. A full overwrite keeps the on-disk dir and `fileIndex` consistent —
 * the agent re-sends the complete script set each update.
 */
export async function upsertSiteSkill(
  name: string,
  description: string,
  body: string,
  scripts?: { path: string; content: string }[],
): Promise<InstalledSkill> {
  await OPFS.rm(`skills/${name}`, { recursive: true });

  const frontmatter = `---\nname: ${name}\ndescription: ${description}\nkind: site\n---\n`;
  await OPFS.writeFile(`skills/${name}/SKILL.md`, frontmatter + body);

  const filePaths = ["SKILL.md"];
  const scriptTypes = new Set<string>();
  for (const s of scripts ?? []) {
    // Confine to the skill dir; reject path traversal. See safeRelPath
    // header for why a regex strip alone is unsound.
    const rel = safeRelPath(s.path);
    await OPFS.writeFile(`skills/${name}/${rel}`, s.content);
    filePaths.push(rel);
    const ext = rel.slice(rel.lastIndexOf("."));
    if (SCRIPT_EXT_TO_TYPE[ext]) scriptTypes.add(SCRIPT_EXT_TO_TYPE[ext]);
  }

  const installedSkill: InstalledSkill = {
    name,
    description,
    source: "site-skill",
    metadata: { name, description, kind: "site" },
    kind: "site",
    hasScripts: scriptTypes.size > 0,
    scriptTypes: [...scriptTypes],
    fileIndex: filePaths,
    installedAt: Date.now(),
  };

  await skillsDb.save(installedSkill);
  return installedSkill;
}

export interface SiteSkillPatch {
  description?: string;
  body?: string;
  upsertScripts?: { path: string; content: string }[];
  deleteScripts?: string[];
}

/**
 * Apply a script-granular patch to a site skill (read-modify-write over
 * `upsertSiteSkill`). Creates the skill if it doesn't exist yet. Only the
 * fields/scripts named in `patch` change; everything else is preserved.
 */
export async function patchSiteSkill(
  name: string,
  patch: SiteSkillPatch,
): Promise<InstalledSkill> {
  const existing = await skillsDb.get(name).catch(() => undefined);

  // Recover current description + body + scripts (empty when creating new).
  let description = existing?.description ?? "";
  let body = "";
  const scripts = new Map<string, string>();

  if (existing && existing.kind === "site") {
    try {
      const md = await OPFS.readFile(`skills/${name}/SKILL.md`);
      body = md.replace(/^---\n[\s\S]*?\n---\n/, "");
    } catch {
      body = "";
    }
    for (const rel of existing.fileIndex ?? []) {
      if (rel === "SKILL.md" || rel.includes("/")) continue;
      try {
        scripts.set(rel, await OPFS.readFile(`skills/${name}/${rel}`));
      } catch {
        // skip missing script file
      }
    }
  }

  if (patch.description !== undefined) description = patch.description;
  if (patch.body !== undefined) body = patch.body;
  for (const s of patch.upsertScripts ?? []) {
    const rel = safeRelPath(s.path);
    scripts.set(rel, s.content);
  }
  for (const p of patch.deleteScripts ?? []) {
    const rel = safeRelPath(p);
    scripts.delete(rel);
  }

  return upsertSiteSkill(
    name,
    description,
    body,
    [...scripts.entries()].map(([path, content]) => ({ path, content })),
  );
}

/** Test-only export: not part of the module's public surface. */
export const _internals = { safeRelPath };

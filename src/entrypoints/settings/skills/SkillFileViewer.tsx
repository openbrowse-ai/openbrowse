import { useMemo } from "react";
import { Markdown } from "@/components/chat/Markdown";
import { CodeViewer } from "@/components/chat/CodeViewer";

export type SkillFileViewMode = "preview" | "code";

interface SkillFileViewerProps {
  /** File name (basename) — used to detect language and whether markdown preview applies. */
  fileName: string;
  /** Raw file content. */
  content: string;
  /** Render mode. Ignored if file is not markdown — always renders as code. */
  mode: SkillFileViewMode;
  /** True while content is loading; renders a placeholder. */
  loading?: boolean;
  /** Optional error message; takes precedence over content when set. */
  error?: string | null;
  /** Show 1-indexed line-number gutter when rendering as code. */
  lineNumbers?: boolean;
  className?: string;
}

function detectLanguage(fileName: string): string {
  const ext = fileName.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    ts: "typescript",
    tsx: "tsx",
    js: "javascript",
    jsx: "jsx",
    mjs: "javascript",
    cjs: "javascript",
    json: "json",
    jsonc: "jsonc",
    py: "python",
    rb: "ruby",
    go: "go",
    rs: "rust",
    java: "java",
    kt: "kotlin",
    swift: "swift",
    c: "c",
    h: "c",
    cpp: "cpp",
    hpp: "cpp",
    cs: "csharp",
    php: "php",
    sh: "bash",
    bash: "bash",
    zsh: "bash",
    yaml: "yaml",
    yml: "yaml",
    toml: "toml",
    xml: "xml",
    html: "html",
    css: "css",
    scss: "scss",
    sql: "sql",
    md: "markdown",
    mdx: "mdx",
  };
  return map[ext] ?? "text";
}

function isMarkdownFile(fileName: string): boolean {
  return fileName.toLowerCase().endsWith(".md");
}

/**
 * Strip a leading YAML frontmatter block from a markdown source so it doesn't
 * appear as a fenced code block in the rendered preview.
 */
function stripFrontmatter(md: string): string {
  const match = md.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n([\s\S]*)$/);
  return match ? match[1] : md;
}

/**
 * Renders a single skill file as either rich markdown preview or a Shiki-
 * highlighted code block. Pure presentational; the parent owns the fetch and
 * the mode toggle.
 */
export function SkillFileViewer({
  fileName,
  content,
  mode,
  loading,
  error,
  lineNumbers,
  className,
}: SkillFileViewerProps) {
  const language = useMemo(() => detectLanguage(fileName), [fileName]);
  const isMarkdown = isMarkdownFile(fileName);

  if (loading) {
    return (
      <div className={className}>
        <div className="text-sm text-muted-foreground italic">Loading…</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className={className}>
        <div className="text-sm text-destructive">Error: {error}</div>
      </div>
    );
  }

  if (mode === "preview" && isMarkdown) {
    return (
      <div className={className}>
        <Markdown source={stripFrontmatter(content)} />
      </div>
    );
  }

  return (
    <CodeViewer
      code={content}
      language={language}
      lineNumbers={lineNumbers}
      className={`text-xs [&_pre]:!bg-transparent [&_pre]:!p-0 [&_pre]:!m-0 [&_code]:!bg-transparent ${className ?? ""}`}
    />
  );
}

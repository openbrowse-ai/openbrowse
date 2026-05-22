import { useMemo } from "react";
import { Markdown } from "@/components/chat/Markdown";
import { CodeViewer } from "@/components/chat/CodeViewer";
import { classifyFile } from "@/lib/vfs/file-classify";
import type { SkillFileContent } from "./useSkillFile";

export type SkillFileViewMode = "preview" | "code";

interface SkillFileViewerProps {
  /** File name (basename) — used to detect language and whether markdown preview applies. */
  fileName: string;
  /**
   * Loaded file content — text or a Blob URL. `null` while the parent has no
   * file selected; show `loading` for the in-flight state.
   */
  content: SkillFileContent | null;
  /** Render mode. Ignored for non-markdown text files (always renders as code). */
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

/**
 * Strip a leading YAML frontmatter block from a markdown source so it doesn't
 * appear as a fenced code block in the rendered preview.
 */
function stripFrontmatter(md: string): string {
  const match = md.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n([\s\S]*)$/);
  return match ? match[1] : md;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/**
 * Renders a single skill file. Dispatches by classified extension:
 * markdown -> rich preview or Shiki, image -> <img>, pdf -> <iframe>,
 * other binary -> "preview not available" stub, code/text -> Shiki.
 *
 * Pure presentational; the parent owns the fetch and the mode toggle.
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
  const fileClass = useMemo(() => classifyFile(fileName), [fileName]);

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

  if (!content) {
    return <div className={className} />;
  }

  if (content.kind === "blob") {
    if (fileClass === "image") {
      return (
        <div className={className}>
          <img
            src={content.blobUrl}
            alt={fileName}
            className="max-w-full max-h-[70vh] object-contain"
          />
        </div>
      );
    }
    if (fileClass === "pdf") {
      return (
        <div className={className}>
          <iframe
            src={content.blobUrl}
            title={fileName}
            className="w-full h-[70vh] border-0"
          />
        </div>
      );
    }
    return (
      <div className={className}>
        <div className="flex flex-col items-center justify-center p-10 gap-2 text-center">
          <span className="text-sm text-muted-foreground">
            Binary file — preview not available
          </span>
          <span className="text-xs text-muted-foreground/70 font-mono">
            {formatBytes(content.blob.size)}
          </span>
        </div>
      </div>
    );
  }

  // content.kind === "text"
  if (mode === "preview" && fileClass === "markdown") {
    return (
      <div className={className}>
        <Markdown source={stripFrontmatter(content.text)} />
      </div>
    );
  }

  return (
    <CodeViewer
      code={content.text}
      language={language}
      lineNumbers={lineNumbers}
      className={`text-xs [&_pre]:!bg-transparent [&_pre]:!p-0 [&_pre]:!m-0 [&_code]:!bg-transparent ${className ?? ""}`}
    />
  );
}

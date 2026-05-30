import type { Root, Link, Text, PhrasingContent, Paragraph } from "mdast";
import { visit } from "unist-util-visit";

const OWNER = "openbrowse-ai";
const REPO = "openbrowse";
const REPO_PREFIX = `https://github.com/${OWNER}/${REPO}`;

/** True when a link points at this repo's compare view. */
export function isCompareUrl(url: string): boolean {
  return (
    url.startsWith(REPO_PREFIX) &&
    /^\/compare\/.+/.test(url.slice(REPO_PREFIX.length))
  );
}

/**
 * Turn a compare range into a short, readable label.
 * `openbrowse@0.3.2...openbrowse@0.4.0` -> `0.3.2 → 0.4.0`
 * Falls back to the decoded raw range when it isn't a `name@version` pair.
 */
export function shortCompareRange(url: string): string {
  const raw = decodeURIComponent(
    url.slice(REPO_PREFIX.length).replace(/^\/compare\//, "").replace(/\/$/, ""),
  );
  const parts = raw.split("...");
  if (parts.length !== 2) return raw;
  const strip = (s: string) => s.replace(new RegExp(`^${REPO}@`), "");
  return `${strip(parts[0])} → ${strip(parts[1])}`;
}

/**
 * Extract this repo's compare URL from raw release-note markdown, if present.
 * GitHub auto-generated notes end with `**Full Changelog**: <compare-url>`.
 */
export function extractCompareUrl(markdown: string): string | undefined {
  const match = markdown.match(
    new RegExp(`${REPO_PREFIX.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}/compare/\\S+`),
  );
  if (!match) return undefined;
  return match[0].replace(/[).,]+$/, "");
}

/**
 * Produce a short, human-friendly label for a GitHub URL pointing at this repo.
 * Returns null when the URL should keep its existing text.
 */
function shortLabel(url: string): string | null {
  if (!url.startsWith(REPO_PREFIX)) return null;
  const rest = url.slice(REPO_PREFIX.length);

  // Pull request: /pull/123  ->  #123
  const pull = rest.match(/^\/pull\/(\d+)\/?$/);
  if (pull) return `#${pull[1]}`;

  // Issue: /issues/123  ->  #123
  const issue = rest.match(/^\/issues\/(\d+)\/?$/);
  if (issue) return `#${issue[1]}`;

  // Commit: /commit/<sha>  ->  <sha7>
  const commit = rest.match(/^\/commit\/([0-9a-f]{7,40})\/?$/i);
  if (commit) return commit[1].slice(0, 7);

  return null;
}

/**
 * remark plugin for changelog release notes.
 *
 * 1. Rewrites the visible text of bare GitHub links pointing at this repo to
 *    compact references (`#65`, a short SHA) so long raw URLs don't overflow.
 * 2. Removes the auto-generated "Full Changelog" compare paragraph entirely.
 *    That line is rendered separately as a Lucide-iconed pill button in the
 *    React component, using the structured `compareUrl`/`compareRange` fields.
 *
 * Link hrefs are always preserved.
 */
export function remarkGithubLinks() {
  return (tree: Root) => {
    // Pass 1: compact bare PR / issue / commit links.
    visit(tree, "link", (node: Link) => {
      const label = shortLabel(node.url);
      if (!label) return;

      const onlyChild = node.children.length === 1 ? node.children[0] : null;
      const childText =
        onlyChild && onlyChild.type === "text" ? (onlyChild as Text).value : null;
      const isBare =
        node.children.length === 0 ||
        (childText !== null && childText.trim() === node.url.trim());

      if (!isBare) return;

      const replacement: PhrasingContent = { type: "text", value: label };
      node.children = [replacement];
    });

    // Pass 2: drop the "Full Changelog" compare paragraph from the prose; it's
    // rendered as a separate React pill from structured release fields. Narrow
    // the match to the auto-generated footer specifically — it must contain a
    // compare link AND the "Full Changelog" marker — so we never delete a
    // release author's own prose that happens to reference a compare URL.
    visit(tree, "paragraph", (para: Paragraph, index, parent) => {
      if (index === undefined || !parent) return;
      const hasCompare = para.children.some(
        (c) => c.type === "link" && isCompareUrl((c as Link).url),
      );
      if (!hasCompare) return;
      // "Full Changelog" is emitted inside a `strong` node, so collect text
      // from nested children — not just top-level `text` nodes.
      const text = collectText(para).toLowerCase().replace(/\s+/g, " ").trim();
      if (!text.includes("full changelog")) return;
      parent.children.splice(index, 1);
      return index; // re-visit the node now at this index
    });
  };
}

/** Concatenate the visible text of a node tree (text + nested children). */
function collectText(node: unknown): string {
  if (!node || typeof node !== "object") return "";
  const n = node as { value?: unknown; children?: unknown };
  if (typeof n.value === "string") return n.value;
  if (Array.isArray(n.children)) {
    return n.children.map((c) => collectText(c)).join("");
  }
  return "";
}

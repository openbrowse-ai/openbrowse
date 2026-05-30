import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkRehype from "remark-rehype";
import rehypeSanitize from "rehype-sanitize";
import rehypeStringify from "rehype-stringify";
import { remarkGithubLinks } from "@/lib/remark-github-links";

const processor = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkGithubLinks)
  .use(remarkRehype)
  .use(rehypeSanitize)
  .use(rehypeStringify);

/**
 * Convert GitHub-Flavored Markdown to sanitized HTML.
 * Sanitization is required because release bodies may contain
 * untrusted content (e.g. community PR descriptions).
 */
export async function renderMarkdown(markdown: string): Promise<string> {
  if (!markdown || markdown.trim() === "") return "";
  const file = await processor.process(markdown);
  return String(file);
}

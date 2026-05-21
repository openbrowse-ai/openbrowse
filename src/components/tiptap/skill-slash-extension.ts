import type {
  JSONContent,
  MarkdownParseHelpers,
  MarkdownParseResult,
  MarkdownToken,
} from "@tiptap/core";
import Mention from "@tiptap/extension-mention";
import { skillSlashSuggestion } from "./skill-slash-suggestion";

/**
 * Tiptap extension that turns `/skill-name` into an inline mention chip in the
 * editor while serialising to plain `/skill-name` in markdown — so the agent
 * sees an unambiguous slash-command token in the user's message.
 *
 * Markdown round-tripping uses a custom inline tokenizer that matches
 * `/[a-z0-9-]+` at the start of a line so general slashes (URLs, paths,
 * "and/or") don't get rewritten.
 */
export const SkillSlash = Mention.extend({
  name: "skillSlash",

  addAttributes() {
    return {
      ...this.parent?.(),
      name: { default: null },
    };
  },

  renderText({ node }) {
    const name = node.attrs.name ?? node.attrs.label ?? node.attrs.id ?? "";
    return `/${name}`;
  },

  renderHTML({ node, HTMLAttributes }) {
    const name = node.attrs.name ?? node.attrs.label ?? node.attrs.id ?? "";
    return [
      "span",
      {
        ...HTMLAttributes,
        "data-type": "skill-slash",
        "data-name": name,
        class: "skill-slash",
      },
      `/${name}`,
    ];
  },

  renderMarkdown(node: JSONContent) {
    const name = node.attrs?.name ?? node.attrs?.label ?? node.attrs?.id ?? "";
    return `/${name}`;
  },

  parseMarkdown(
    token: MarkdownToken,
    _helpers: MarkdownParseHelpers,
  ): MarkdownParseResult {
    const raw = (token as { raw?: string }).raw ?? "";
    const name = raw.replace(/^\//, "");
    return {
      type: "skillSlash",
      attrs: {
        id: name,
        label: name,
        name,
      },
    };
  },

  markdownTokenizer: {
    name: "skillSlash",
    level: "inline" as const,
    start(src: string) {
      // Only match a slash that's at the start of input or after whitespace.
      const m = src.match(/(^|\s)\/[a-z0-9-]+/);
      if (!m) return -1;
      // Index of the slash itself (skip the optional leading whitespace).
      return (m.index ?? 0) + (m[1] ? m[1].length : 0);
    },
    tokenize(src: string) {
      const match = src.match(/^\/([a-z0-9-]+)/);
      if (!match) return undefined;
      return {
        type: "skillSlash",
        raw: match[0],
        name: match[1],
      };
    },
  },
}).configure({
  suggestion: skillSlashSuggestion,
  HTMLAttributes: { class: "skill-slash" },
});

export const SkillSlashReadonly = Mention.extend({
  name: "skillSlash",

  addAttributes() {
    return {
      ...this.parent?.(),
      name: { default: null },
    };
  },

  renderHTML({ node, HTMLAttributes }) {
    const name = node.attrs.name ?? node.attrs.label ?? node.attrs.id ?? "";
    return [
      "span",
      {
        ...HTMLAttributes,
        "data-type": "skill-slash",
        "data-name": name,
        class: "skill-slash",
      },
      `/${name}`,
    ];
  },

  parseMarkdown(
    token: MarkdownToken,
    _helpers: MarkdownParseHelpers,
  ): MarkdownParseResult {
    const raw = (token as { raw?: string }).raw ?? "";
    const name = raw.replace(/^\//, "");
    return {
      type: "skillSlash",
      attrs: {
        id: name,
        label: name,
        name,
      },
    };
  },

  markdownTokenizer: {
    name: "skillSlash",
    level: "inline" as const,
    start(src: string) {
      const m = src.match(/(^|\s)\/[a-z0-9-]+/);
      if (!m) return -1;
      return (m.index ?? 0) + (m[1] ? m[1].length : 0);
    },
    tokenize(src: string) {
      const match = src.match(/^\/([a-z0-9-]+)/);
      if (!match) return undefined;
      return {
        type: "skillSlash",
        raw: match[0],
        name: match[1],
      };
    },
  },
});

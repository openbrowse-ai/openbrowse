import Mention from "@tiptap/extension-mention";
import type { JSONContent, MarkdownToken, MarkdownParseHelpers, MarkdownParseResult } from "@tiptap/core";
import { tabMentionSuggestion } from "./tab-mention-suggestion";

export const TabMention = Mention.extend({
  name: "tabMention",

  addAttributes() {
    return {
      ...this.parent?.(),
      title: { default: null },
      url: { default: null },
      favicon: { default: null },
    };
  },

  renderText({ node }) {
    const title = node.attrs.title ?? node.attrs.label ?? "";
    const url = node.attrs.url ?? node.attrs.id ?? "";
    return `@[${title}](${url})`;
  },

  renderHTML({ node, HTMLAttributes }) {
    return [
      "span",
      {
        ...HTMLAttributes,
        "data-type": "tab-mention",
        "data-url": node.attrs.url,
        class: "tab-mention",
      },
      `@${node.attrs.title ?? node.attrs.label}`,
    ];
  },

  renderMarkdown(node: JSONContent) {
    const title = node.attrs?.title ?? node.attrs?.label ?? "";
    const url = node.attrs?.url ?? node.attrs?.id ?? "";
    return `@[${title}](${url})`;
  },

  parseMarkdown(token: MarkdownToken, _helpers: MarkdownParseHelpers): MarkdownParseResult {
    return {
      type: "tabMention",
      attrs: {
        id: token.url,
        label: token.title,
        title: token.title,
        url: token.url,
      },
    };
  },

  markdownTokenizer: {
    name: "tabMention",
    level: "inline" as const,
    start(src: string) {
      const index = src.indexOf("@[");
      return index !== -1 ? index : -1;
    },
    tokenize(src: string) {
      const match = src.match(/^@\[([^\]]+)\]\(([^)]+)\)/);
      if (!match) return undefined;
      return {
        type: "tabMention",
        raw: match[0],
        title: match[1],
        url: match[2],
      };
    },
  },
}).configure({
  suggestion: tabMentionSuggestion,
  HTMLAttributes: { class: "tab-mention" },
});

export const TabMentionReadonly = Mention.extend({
  name: "tabMention",

  addAttributes() {
    return {
      ...this.parent?.(),
      title: { default: null },
      url: { default: null },
      favicon: { default: null },
    };
  },

  renderHTML({ node, HTMLAttributes }) {
    return [
      "span",
      {
        ...HTMLAttributes,
        "data-type": "tab-mention",
        "data-url": node.attrs.url,
        class: "tab-mention",
      },
      `@${node.attrs.title ?? node.attrs.label}`,
    ];
  },

  parseMarkdown(token: MarkdownToken, _helpers: MarkdownParseHelpers): MarkdownParseResult {
    return {
      type: "tabMention",
      attrs: {
        id: token.url,
        label: token.title,
        title: token.title,
        url: token.url,
      },
    };
  },

  markdownTokenizer: {
    name: "tabMention",
    level: "inline" as const,
    start(src: string) {
      const index = src.indexOf("@[");
      return index !== -1 ? index : -1;
    },
    tokenize(src: string) {
      const match = src.match(/^@\[([^\]]+)\]\(([^)]+)\)/);
      if (!match) return undefined;
      return {
        type: "tabMention",
        raw: match[0],
        title: match[1],
        url: match[2],
      };
    },
  },
});

import type {
    JSONContent,
    MarkdownParseHelpers,
    MarkdownParseResult,
    MarkdownToken,
} from "@tiptap/core";
import Mention from "@tiptap/extension-mention";

/**
 * Inline chip node for a mentioned past chat. Chats are inserted from the
 * unified `@` mention popup (see `mention-suggestion.ts`); this extension owns
 * only the node schema, rendering, and markdown round-tripping — it does NOT
 * register its own suggestion plugin (that would fight the tab-mention
 * extension for the `@` trigger).
 *
 * Serialises to `#[Title](chat:<conversationId>)` in markdown. The `chat:`
 * scheme keeps the token unambiguous and distinct from tab mentions
 * (`@[title](https://...)`), so the two inline tokenizers never collide and
 * `ChatInput.formatChatMentionContext` can recover the referenced
 * conversation's transcript from the sent text as model-only context.
 */
const chatMarkdownTokenizer = {
  name: "chatMention",
  level: "inline" as const,
  start(src: string) {
    const index = src.indexOf("#[");
    return index !== -1 ? index : -1;
  },
  tokenize(src: string) {
    const match = src.match(/^#\[([^\]]+)\]\(chat:([^)]+)\)/);
    if (!match) return undefined;
    return {
      type: "chatMention",
      raw: match[0],
      title: match[1],
      // Reuse the typed `url` token field to carry the conversation id.
      url: match[2],
    };
  },
};

function parseChatMarkdown(
  token: MarkdownToken,
  _helpers: MarkdownParseHelpers,
): MarkdownParseResult {
  return {
    type: "chatMention",
    attrs: {
      id: token.url,
      label: token.title,
      title: token.title,
      conversationId: token.url,
    },
  };
}

/**
 * Chip label. Chats are triggered from `@` alongside tabs, so the chip reads
 * `@Title` to match the tab-mention convention; the distinct `.chat-mention`
 * class carries any visual differentiation.
 */
function chipLabel(node: { attrs: Record<string, unknown> }): string {
  const title = (node.attrs.title ?? node.attrs.label ?? "") as string;
  return `@${title}`;
}

const chatAttributes = {
  title: { default: null },
  conversationId: { default: null },
};

export const ChatMention = Mention.extend({
  name: "chatMention",

  // Node-only: the unified `@` suggestion (mention-suggestion.ts) drives
  // insertion. Suppressing Mention's default Suggestion plugin prevents a
  // second `@` handler from clashing with the tab-mention extension.
  addProseMirrorPlugins() {
    return [];
  },

  addAttributes() {
    return {
      ...this.parent?.(),
      ...chatAttributes,
    };
  },

  renderText({ node }) {
    const title = node.attrs.title ?? node.attrs.label ?? "";
    const id = node.attrs.conversationId ?? node.attrs.id ?? "";
    return `#[${title}](chat:${id})`;
  },

  renderHTML({ node, HTMLAttributes }) {
    return [
      "span",
      {
        ...HTMLAttributes,
        "data-type": "chat-mention",
        "data-conversation-id": node.attrs.conversationId ?? node.attrs.id,
        class: "chat-mention",
      },
      chipLabel(node),
    ];
  },

  renderMarkdown(node: JSONContent) {
    const title = node.attrs?.title ?? node.attrs?.label ?? "";
    const id = node.attrs?.conversationId ?? node.attrs?.id ?? "";
    return `#[${title}](chat:${id})`;
  },

  parseMarkdown: parseChatMarkdown,

  markdownTokenizer: chatMarkdownTokenizer,
});

export const ChatMentionReadonly = Mention.extend({
  name: "chatMention",

  addProseMirrorPlugins() {
    return [];
  },

  addAttributes() {
    return {
      ...this.parent?.(),
      ...chatAttributes,
    };
  },

  renderHTML({ node, HTMLAttributes }) {
    return [
      "span",
      {
        ...HTMLAttributes,
        "data-type": "chat-mention",
        "data-conversation-id": node.attrs.conversationId ?? node.attrs.id,
        class: "chat-mention",
      },
      chipLabel(node),
    ];
  },

  parseMarkdown: parseChatMarkdown,

  markdownTokenizer: chatMarkdownTokenizer,
});

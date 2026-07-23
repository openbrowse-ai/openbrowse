import { chatDb } from "@/lib/chat-db";
import { computePosition, flip, offset, shift } from "@floating-ui/dom";
import { ReactRenderer } from "@tiptap/react";
import type { SuggestionOptions } from "@tiptap/suggestion";
import {
    MentionList,
    type MentionItem,
    type MentionListRef,
} from "./MentionList";

// Keep each group short enough that the combined popup stays scannable when
// the query is empty (bare `@`). Filtered queries reuse the same caps.
const TAB_LIMIT = 12;
const CHAT_LIMIT = 8;

async function queryTabs(query: string): Promise<MentionItem[]> {
  const homeUrl = chrome.runtime.getURL("/home.html");
  const sidepanelUrl = chrome.runtime.getURL("/sidepanel.html");
  const currentWindow = await chrome.windows.getCurrent();
  const tabs = await chrome.tabs.query({ windowId: currentWindow.id });

  const q = query.toLowerCase();
  return tabs
    .filter(
      (t) =>
        t.url &&
        !t.url.startsWith(homeUrl) &&
        !t.url.startsWith(sidepanelUrl) &&
        (t.title?.toLowerCase().includes(q) || t.url.toLowerCase().includes(q)),
    )
    .slice(0, TAB_LIMIT)
    .map((t) => ({
      kind: "tab" as const,
      id: String(t.id!),
      title: t.title ?? "Untitled",
      url: t.url!,
      favicon: t.favIconUrl ?? "",
    }));
}

async function queryChats(query: string): Promise<MentionItem[]> {
  // List across all spaces (the suggestion module has no space context).
  // `listRootConversations` already drops auto-spawned subagent children,
  // so only user-facing chats surface as mention targets.
  const convs = await chatDb.listRootConversations();
  const q = query.toLowerCase();
  return convs
    .filter((c) => (q ? c.title.toLowerCase().includes(q) : true))
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, CHAT_LIMIT)
    .map((c) => ({
      kind: "chat" as const,
      id: c.id,
      title: c.title || "Untitled chat",
      updatedAt: c.updatedAt,
    }));
}

/**
 * Unified `@` suggestion covering both open tabs and past chats. Tabs are
 * listed first, then chats; `MentionList` renders them as two labelled groups
 * over a single keyboard cursor.
 *
 * The custom `command` is what makes one trigger insert two different node
 * types: tabs become `tabMention` nodes (`@[title](url)`), chats become
 * `chatMention` nodes (`#[title](chat:id)`). Keeping distinct node types (and
 * distinct markdown tokens) means the tab-mention and chat-mention extraction
 * paths stay independent and unambiguous.
 */
export const mentionSuggestion: Partial<SuggestionOptions<MentionItem>> = {
  char: "@",
  allowSpaces: true,

  items: async ({ query }) => {
    const [tabs, chats] = await Promise.all([
      queryTabs(query),
      queryChats(query),
    ]);
    return [...tabs, ...chats];
  },

  command: ({ editor, range, props }) => {
    const item = props as unknown as MentionItem;

    // Mirror @tiptap/extension-mention's default command: absorb a trailing
    // space that already follows the trigger so we don't double it up.
    const nodeAfter = editor.view.state.selection.$to.nodeAfter;
    if (nodeAfter?.text?.startsWith(" ")) {
      range.to += 1;
    }

    const node =
      item.kind === "chat"
        ? {
            type: "chatMention",
            attrs: {
              id: item.id,
              label: item.title,
              title: item.title,
              conversationId: item.id,
            },
          }
        : {
            type: "tabMention",
            attrs: {
              id: item.url,
              label: item.title,
              title: item.title,
              url: item.url,
              favicon: item.favicon,
            },
          };

    editor
      .chain()
      .focus()
      .insertContentAt(range, [node, { type: "text", text: " " }])
      .run();

    editor.view.dom.ownerDocument.defaultView
      ?.getSelection()
      ?.collapseToEnd();
  },

  render: () => {
    let component: ReactRenderer<MentionListRef>;
    let floating: HTMLElement;

    return {
      onStart: (props) => {
        component = new ReactRenderer(MentionList, {
          props: {
            items: props.items,
            command: (item: MentionItem) => props.command(item),
          },
          editor: props.editor,
        });

        floating = document.createElement("div");
        floating.style.position = "absolute";
        floating.style.zIndex = "100";
        document.body.appendChild(floating);
        floating.appendChild(component.element);

        updatePosition(floating, props.clientRect);
      },

      onUpdate: (props) => {
        component.updateProps({
          items: props.items,
          command: (item: MentionItem) => props.command(item),
        });
        updatePosition(floating, props.clientRect);
      },

      onKeyDown: (props) => {
        if (props.event.key === "Escape") {
          floating.style.display = "none";
          return true;
        }
        return component.ref?.onKeyDown(props) ?? false;
      },

      onExit: () => {
        component?.destroy();
        if (floating?.parentNode) {
          floating.parentNode.removeChild(floating);
        }
      },
    };
  },
};

async function updatePosition(
  floating: HTMLElement,
  clientRect: (() => DOMRect | null) | null | undefined,
) {
  if (!floating || !clientRect) return;
  const rect = clientRect();
  if (!rect) return;

  const virtualEl = {
    getBoundingClientRect: () => rect,
  };

  const { x, y } = await computePosition(virtualEl as Element, floating, {
    placement: "bottom-start",
    middleware: [offset(6), flip(), shift({ padding: 8 })],
  });

  Object.assign(floating.style, {
    left: `${x}px`,
    top: `${y}px`,
  });
}

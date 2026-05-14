import { ReactRenderer } from "@tiptap/react";
import type { SuggestionOptions } from "@tiptap/suggestion";
import { computePosition, flip, shift, offset } from "@floating-ui/dom";
import { TabMentionList, type TabMentionListRef, type TabSuggestionItem } from "./TabMentionList";

async function queryTabs(query: string): Promise<TabSuggestionItem[]> {
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
    .map((t) => ({
      id: String(t.id!),
      title: t.title ?? "Untitled",
      url: t.url!,
      favicon: t.favIconUrl ?? "",
    }));
}

export const tabMentionSuggestion: Partial<SuggestionOptions<TabSuggestionItem>> = {
  char: "@",
  allowSpaces: true,

  items: async ({ query }) => {
    return queryTabs(query);
  },

  render: () => {
    let component: ReactRenderer<TabMentionListRef>;
    let floating: HTMLElement;

    return {
      onStart: (props) => {
        component = new ReactRenderer(TabMentionList, {
          props: {
            items: props.items,
            command: (item: TabSuggestionItem) => {
              props.command({
                id: item.url,
                label: item.title,
                title: item.title,
                url: item.url,
                favicon: item.favicon,
              });
            },
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
          command: (item: TabSuggestionItem) => {
            props.command({
              id: item.url,
              label: item.title,
              title: item.title,
              url: item.url,
              favicon: item.favicon,
            });
          },
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

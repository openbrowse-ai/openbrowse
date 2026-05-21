import { ReactRenderer } from "@tiptap/react";
import type { SuggestionOptions } from "@tiptap/suggestion";
import { computePosition, flip, shift, offset } from "@floating-ui/dom";
import { getSkillsRegistry } from "@/lib/skills/registry";
import {
  SkillSlashList,
  type SkillSlashListRef,
  type SkillSuggestionItem,
} from "./SkillSlashList";

function querySkills(query: string): SkillSuggestionItem[] {
  const state = getSkillsRegistry().getState();
  const q = query.toLowerCase();
  // Only enabled skills are surfaced as slash-command targets — disabled
  // skills won't be picked up by the agent anyway.
  return state.skills
    .filter((s) => s.enabled !== false)
    .filter((s) => {
      if (!q) return true;
      return (
        s.name.toLowerCase().includes(q) ||
        s.description.toLowerCase().includes(q)
      );
    })
    .map((s) => ({ name: s.name, description: s.description }));
}

export const skillSlashSuggestion: Partial<SuggestionOptions<SkillSuggestionItem>> = {
  char: "/",
  // Only trigger at the start of a line, so "and/or" or path-like text doesn't
  // open the popup mid-sentence. tiptap's default startOfLine semantics:
  startOfLine: true,
  allowSpaces: false,

  items: ({ query }) => {
    return querySkills(query);
  },

  render: () => {
    let component: ReactRenderer<SkillSlashListRef>;
    let floating: HTMLElement;

    return {
      onStart: (props) => {
        component = new ReactRenderer(SkillSlashList, {
          props: {
            items: props.items,
            command: (item: SkillSuggestionItem) => {
              props.command({
                id: item.name,
                label: item.name,
                name: item.name,
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
          command: (item: SkillSuggestionItem) => {
            props.command({
              id: item.name,
              label: item.name,
              name: item.name,
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
    placement: "top-start",
    middleware: [offset(6), flip(), shift({ padding: 8 })],
  });

  Object.assign(floating.style, {
    left: `${x}px`,
    top: `${y}px`,
  });
}

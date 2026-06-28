import { z } from "zod";
import { chatDb } from "@/lib/chat-db";
import type { BrowserTool } from "../types";

/**
 * DOM event broadcast by `setTaskTitle` so the parent's `DelegateResult`
 * block can update its trigger title live, while the subagent is still
 * running. Detail carries the parent's `delegate` tool call id so the
 * matching block (and only it) updates.
 */
export const SUBAGENT_TITLE_UPDATED_EVENT =
  "openbrowse:subagent-title-updated";

export interface SubagentTitleUpdatedDetail {
  toolCallId: string;
  title: string;
}

const parameters = z.object({
  title: z
    .string()
    .min(1)
    .max(120)
    .describe(
      "Short, present-tense description of your current phase (e.g. 'Reading product pages', 'Comparing prices across 5 stores'). Update as you progress.",
    ),
});

type Input = z.infer<typeof parameters>;

type Output =
  | { ok: true }
  | { ok: false; error: string };

/**
 * Subagent-only tool. Sets the trace title displayed in the parent's
 * `DelegateResult` block (and the child conversation's breadcrumb).
 *
 * Behavior:
 *   - persists to the child Conversation row's `subagentTraceTitle`
 *     field so reloads survive.
 *   - dispatches `SUBAGENT_TITLE_UPDATED_EVENT` keyed to the parent's
 *     `delegate` tool call id for live updates without polling.
 *
 * The parent agent does not have access to this tool — it's added to
 * built-in subagent allowlists and stripped at the parent's tool-set
 * boundary. Calling it from a non-subagent context (no `session.parent`)
 * is a no-op error.
 */
export const setTaskTitleTool: BrowserTool<Input, Output> = {
  name: "setTaskTitle",
  description:
    "Set or update the trace title shown in your parent's UI for this subagent run. Call this whenever you start a new phase of work — short present-tense phrases like 'Reading product pages', 'Comparing prices across 5 stores', 'Filling signup form'. The parent and the user see this update immediately.",
  parameters,
  execute: async (input, ctx): Promise<Output> => {
    const parsed = parameters.safeParse(input);
    if (!parsed.success) {
      return {
        ok: false,
        error:
          parsed.error.issues[0]?.message ??
          "Invalid title (must be 1–120 chars).",
      };
    }
    const title = parsed.data.title.trim();
    if (title.length === 0) {
      return { ok: false, error: "Title is empty after trimming whitespace." };
    }

    const session = ctx.session;
    const parent = session?.parent;
    if (!parent) {
      return {
        ok: false,
        error:
          "setTaskTitle can only be called from inside a subagent run (no session.parent).",
      };
    }

    const childConvId = session?.conversationId;
    if (childConvId) {
      try {
        await chatDb.updateConversation(childConvId, {
          subagentTraceTitle: title,
          updatedAt: Date.now(),
        });
      } catch (err) {
        // Persistence failure is non-fatal — the live event still
        // fires and the parent's UI updates. Logging only.
        console.warn(
          "[setTaskTitle] failed to persist subagentTraceTitle:",
          err,
        );
      }
    }

    // Broadcast for live UI update. Only fires when we have the parent's
    // tool call id (production path); test / non-extension contexts may
    // omit it without breaking the run.
    if (parent.toolCallId) {
      try {
        if (typeof window !== "undefined") {
          window.dispatchEvent(
            new CustomEvent<SubagentTitleUpdatedDetail>(
              SUBAGENT_TITLE_UPDATED_EVENT,
              {
                detail: {
                  toolCallId: parent.toolCallId,
                  title,
                },
              },
            ),
          );
        } else if (typeof chrome !== "undefined" && chrome.runtime?.sendMessage) {
          // SW realm (post-SW-host): no DOM. Forward via runtime
          // messaging so the renderer's DelegateResult block still gets
          // the live title update.
          chrome.runtime
            .sendMessage({
              type: SUBAGENT_TITLE_UPDATED_EVENT,
              detail: {
                toolCallId: parent.toolCallId,
                title,
              },
            })
            ?.catch?.(() => {});
        }
      } catch {
        // Non-DOM, no runtime messaging (tests). Persistence still works
        // for peer / incognito; inline simply has no live update.
      }
    }

    return { ok: true };
  },
};

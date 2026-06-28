import { z } from "zod";
import { chatDb } from "../../chat-db";
import { isServiceWorkerContext } from "@/lib/runtime/context";
import type { BrowserTool } from "../types";

const parameters = z.object({
  target: z
    .enum(["group", "tabs"])
    .describe(
      "What to close: 'group' closes the whole conversation's tab group (use when the task is fully complete); 'tabs' closes a specific set of tab handles.",
    ),
  handles: z
    .array(z.string())
    .min(1)
    .optional()
    .describe(
      "Required when target is 'tabs'. Tab handles to close (e.g. ['t1','t3']) from the tab legend or listTabs. Ignored when target is 'group'.",
    ),
});

type Input = z.infer<typeof parameters>;

const outputSchema = z.object({
  closed: z.number(),
  undo: z
    .object({
      action: z.literal("reopen"),
      id: z.string(),
      tabs: z.array(
        z.object({ url: z.string(), windowId: z.number(), pinned: z.boolean() }),
      ),
    })
    .optional(),
  note: z.string().optional(),
  error: z.string().optional(),
});
type Output = z.infer<typeof outputSchema>;

export const closeTabsTool: BrowserTool<Input, Output> = {
  name: "closeTabs",
  description:
    "Close tabs this conversation opened. Pass `{ target: 'group' }` to close all of the conversation's tabs (use when the task is fully complete), or `{ target: 'tabs', handles: [...] }` to close specific tabs you opened but no longer need (e.g. scratch/search tabs) while keeping the result tab. Closing is reversible via an Undo toast. Requires user approval.",
  parameters,
  outputSchema,
  approval: { required: true },
  execute: async (input, ctx) => {
    const cid = ctx.session?.conversationId;
    if (!cid) {
      return { closed: 0, error: "No active conversation." };
    }

    let ltidsToClose: string[];
    if (input.target === "group") {
      const conv = await chatDb.getConversation(cid);
      ltidsToClose = conv?.ownedLtids ?? [];
    } else {
      // input.target === "tabs"
      if (!input.handles || input.handles.length === 0) {
        return {
          closed: 0,
          error: "target 'tabs' requires a non-empty 'handles' array.",
        };
      }
      ltidsToClose = [];
      for (const handle of input.handles) {
        const ltid = ctx.session?.resolveHandle?.(handle);
        if (ltid == null) {
          throw new Error(
            `Tab handle "${handle}" not found. Use listTabs to see available tabs.`,
          );
        }
        ltidsToClose.push(ltid as string);
      }
    }

    if (ltidsToClose.length === 0) {
      return {
        closed: 0,
        note: "No tabs to close — the conversation has no open owned tabs.",
      };
    }

    try {
      // Realm-aware: SW callers (under SW-host) cannot deliver
      // chrome.runtime.sendMessage to the SW's own listener for
      // CLOSE_AGENT_TABS. Call the handler in-process; otherwise fall
      // back to the wire protocol the renderer has always used.
      let res: { ok: boolean; undo?: Output["undo"]; error?: string };
      if (isServiceWorkerContext()) {
        const { handleCloseAgentTabs } = await import(
          "@/entrypoints/background/close-agent-tabs"
        );
        res = (await handleCloseAgentTabs({
          conversationId: cid,
          ltids: ltidsToClose,
        })) as typeof res;
        // The SW listener also broadcasts AGENT_TABS_CLOSED so the
        // renderer can show its Undo toast. Mirror that here so the UX
        // is identical regardless of which realm initiated the close.
        if (res.ok && res.undo && res.undo.tabs.length > 0) {
          try {
            await chrome.runtime.sendMessage({
              type: "AGENT_TABS_CLOSED",
              conversationId: cid,
              undo: res.undo,
            });
          } catch {
            // No renderer listening; the close still succeeded.
          }
        }
      } else {
        res = (await chrome.runtime.sendMessage({
          type: "CLOSE_AGENT_TABS",
          conversationId: cid,
          // Send ltids over the wire. The background handler resolves each
          // ltid back to a live ctid via the registry just before
          // `chrome.tabs.remove`.
          ltids: ltidsToClose,
        })) as typeof res;
      }
      if (!res?.ok) {
        return { closed: 0, error: res?.error ?? "Close failed." };
      }
      return { closed: res.undo?.tabs.length ?? ltidsToClose.length, undo: res.undo };
    } catch (err) {
      return { closed: 0, error: err instanceof Error ? err.message : String(err) };
    }
  },
};

import { z } from "zod";
import { chatDb } from "../../chat-db";
import type { BrowserTool } from "../types";

const parameters = z
  .discriminatedUnion("target", [
    z
      .object({
        target: z.literal("group"),
      })
      .strict(),
    z
      .object({
        target: z.literal("tabs"),
        handles: z
          .array(z.string())
          .min(1)
          .describe("Tab handles to close (e.g. ['t1','t3']). From the tab legend or listTabs."),
      })
      .strict(),
  ])
  .describe(
    "What to close: the whole conversation's tab group, or a specific set of tab handles.",
  );

type Input = z.infer<typeof parameters>;

const outputSchema = z.object({
  closed: z.number(),
  undo: z
    .object({
      action: z.literal("reopen"),
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

    let tabIds: number[];
    if (input.target === "group") {
      const conv = await chatDb.getConversation(cid);
      tabIds = conv?.ownedTabIds ?? [];
    } else {
      tabIds = [];
      for (const handle of input.handles) {
        const id = ctx.session?.resolveHandle?.(handle);
        if (id == null) {
          throw new Error(
            `Tab handle "${handle}" not found. Use listTabs to see available tabs.`,
          );
        }
        tabIds.push(id as number);
      }
    }

    if (tabIds.length === 0) {
      return {
        closed: 0,
        note: "No tabs to close — the conversation has no open owned tabs.",
      };
    }

    try {
      const res = (await chrome.runtime.sendMessage({
        type: "CLOSE_AGENT_TABS",
        conversationId: cid,
        tabIds,
      })) as { ok: boolean; undo?: Output["undo"]; error?: string };
      if (!res?.ok) {
        return { closed: 0, error: res?.error ?? "Close failed." };
      }
      return { closed: res.undo?.tabs.length ?? tabIds.length, undo: res.undo };
    } catch (err) {
      return { closed: 0, error: err instanceof Error ? err.message : String(err) };
    }
  },
};

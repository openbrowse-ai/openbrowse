import { z } from "zod";
import { handleForTab, resolveTabOrThrow } from "../driver";
import { invalidateRefs } from "../ref-store";
import { captureSnapshot } from "../snapshot-capture";
import type { BrowserTool } from "../types";

const parameters = z
  .object({
    url: z.string().describe("The URL to navigate to"),
    tab: z
      .string()
      .optional()
      .describe(
        "Tab handle (e.g. 't1') to navigate. Omit to open a new background tab — that's the only way to acquire a fresh handle, e.g. on the first action of a conversation. See the `## Tabs in this conversation` section of the system prompt, or call listTabs.",
      ),
  })
  .strict();

type Input = z.infer<typeof parameters>;

const outputSchema = z.object({
  navigated: z.boolean(),
  url: z.string(),
  tab: z.string().optional(),
  snapshot: z.string().optional(),
  refCount: z.number().optional(),
  note: z.string().optional(),
  error: z.string().optional(),
});
type Output = z.infer<typeof outputSchema>;

export const navigateTool: BrowserTool<Input, Output> = {
  name: "navigate",
  description:
    "Navigate to a URL. Pass `tab` to navigate an existing tab (the response includes that handle); omit `tab` to open a new background tab and receive a fresh handle in the response. The response automatically includes a snapshot of the landed page so you can interact immediately. Use this as the first action of a conversation when you have no handles yet.",
  parameters,
  outputSchema,
  execute: async ({ url, tab: handle }, ctx) => {
    let tabId: ReturnType<typeof ctx.driver.getActiveTabId> = null;
    let createdNew = false;

    if (handle) {
      // Navigate the named tab. We deliberately allow the agent to navigate
      // a tab it didn't open ("user-shared tab"); the only restriction is
      // that the handle must resolve.
      const target = await resolveTabOrThrow(ctx, handle);
      try {
        await ctx.driver.updateTabUrl(target.id, url);
        tabId = target.id;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          navigated: false,
          url,
          tab: handle,
          error: message,
          note: `Failed to navigate ${handle}: ${message}. The tab may have been closed.`,
        };
      }
    } else {
      // No handle → create a new background tab. This is the bootstrap
      // path used on the first action of a conversation. The new tab
      // should land in the conversation's own window — where the chat
      // and the agent's existing tabs live — not whatever window Chrome
      // happens to have focused.
      //
      // Window resolution has THREE layered defenses, in order:
      //
      //   1. `session.targetWindowId` (sync): stamped by the runner for
      //      incognito subagents (their fresh incognito window) and by
      //      `buildExtensionToolContext` for the root agent from the
      //      pre-warmed cache.
      //   2. `session.resolveNewTabWindowId()` (async): the parent's
      //      closure that resolves owned-tab → originWindowId → space
      //      window for the PARENT's cid. Subagents inherit this closure
      //      via the runner's `...parentToolContext.session` spread, so
      //      a peer subagent's navigate resolves to the PARENT's window
      //      (which is the user's mental model: subagents work in the
      //      same window as their parent chat).
      //   3. Direct fallback (async): when (1) AND (2) both fail (e.g.
      //      the renderer-cached session didn't get a chance to stamp
      //      targetWindowId AND the parent closure isn't wired), we
      //      resolve the conversation's window from the SUBAGENT's own
      //      cid via `resolveConversationWindowId`. Child conversations
      //      inherit `originWindowId` from their parent at creation
      //      time (see `subagents/child-conversation.ts`), so this
      //      degrades to the parent's origin window. Only kicks in for
      //      pathological harnesses where both upper layers are absent.
      //
      // When all three yield undefined, `windowId` is omitted and
      // Chrome falls back to the focused window (legacy behavior).
      let targetWindowId: number | undefined = ctx.session?.targetWindowId;
      if (targetWindowId === undefined) {
        try {
          targetWindowId = await Promise.resolve(
            ctx.session?.resolveNewTabWindowId?.(),
          ).catch(() => undefined);
        } catch {
          targetWindowId = undefined;
        }
      }
      if (targetWindowId === undefined && ctx.session?.conversationId) {
        try {
          // Variable-indirection import (instead of a string-literal
          // `import("../conversation-window")`) is deliberate: it hides
          // the module from tsc's static module-graph walk so
          // `packages/bench` (no `@/*` path alias, no chrome ambient
          // types) doesn't transitively typecheck this chain. Runtime
          // resolution via the bundler is unaffected. See the
          // matching comment in `active-tab.ts`.
          const modulePath: string = "../conversation-window";
          const mod = (await import(modulePath)) as {
            resolveConversationWindowId: (
              cid: string,
            ) => Promise<number | undefined>;
          };
          targetWindowId = await mod.resolveConversationWindowId(
            ctx.session.conversationId,
          );
        } catch {
          // best-effort
        }
      }
      tabId = await ctx.driver.createTab(url, {
        active: false,
        ...(targetWindowId !== undefined && { windowId: targetWindowId }),
      });
      createdNew = true;
    }

    if (createdNew) {
      await ctx.session?.bindTabsToConversation?.([tabId]);
    }

    await ctx.driver.setActiveTab(tabId);
    // Navigation is a genuine page change — unlike click/type/scroll, the old
    // page's elements are gone, so we DO want a clean slate. Invalidating here
    // also clears the ref-store carry-over pool so stale cross-page refs can't
    // leak into the post-navigation snapshot's merge.
    invalidateRefs(tabId);
    await ctx.driver.waitForLoad(tabId);

    const resolvedHandle = handleForTab(ctx, tabId);

    // Auto-attach initial snapshot so the agent can act on the new page
    // without a follow-up snapshot call.
    try {
      const cap = await captureSnapshot(ctx.driver, tabId);
      return {
        navigated: true,
        url,
        tab: resolvedHandle,
        snapshot: cap.snapshotText,
        refCount: cap.refs.size,
        // Surface cross-extension frame exclusion (e.g. password-manager
        // iframes) so the agent knows the snapshot isn't whole-tree.
        ...(cap.note ? { note: cap.note } : {}),
      };
    } catch (err) {
      return {
        navigated: true,
        url,
        tab: resolvedHandle,
        note: `Navigation succeeded but initial snapshot failed: ${
          err instanceof Error ? err.message : String(err)
        }. Call snapshot to retry.`,
      };
    }
  },
};

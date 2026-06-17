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
      // happens to have focused. For incognito subagents the runner sets
      // a static `session.targetWindowId` (their fresh incognito window);
      // for the root agent we resolve it dynamically via
      // `resolveNewTabWindowId` (owned-tab window → space window). When
      // neither yields a window, `windowId` is omitted and Chrome falls
      // back to the focused window (legacy behavior). The resolver runs
      // best-effort: a rejection is swallowed to `undefined` so a transient
      // lookup failure degrades to the focused window rather than aborting
      // the navigation.
      const targetWindowId =
        ctx.session?.targetWindowId ??
        (await Promise.resolve(ctx.session?.resolveNewTabWindowId?.()).catch(
          () => undefined,
        ));
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

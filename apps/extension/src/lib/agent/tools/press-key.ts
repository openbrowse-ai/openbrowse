import { z } from "zod";
import { isDetachError } from "../cdp-errors";
import { setShieldPassthrough } from "../click-diagnostic";
import type { BrowserDriver, TabId } from "../driver";
import { resolveTabOrThrow } from "../driver";
import {
  getRef,
  invalidateRefsIfNavigated,
} from "../ref-store";
import { dispatchKeyCombo } from "../keyboard";
import { captureSnapshot, findNodeByRoleNameNth } from "../snapshot-capture";
import { scrollIntoViewIfNeeded } from "../viewport";
import type { BrowserTool } from "../types";

const parameters = z.object({
  tab: z
    .string()
    .describe(
      "Tab handle to press the key in (e.g. 't1'). See the `## Tabs in this conversation` section of the system prompt, or call listTabs.",
    ),
  key: z
    .string()
    .describe(
      "Key or combo to press. Single keys: 'Enter', 'Escape', 'Tab', 'Backspace', 'Delete', 'ArrowUp'/'ArrowDown'/'ArrowLeft'/'ArrowRight', 'PageUp', 'PageDown', 'Home', 'End', 'Space', or a single character like 'a' or '/'. Combos use '+': 'ctrl+a', 'shift+Tab', 'cmd+c'. The key goes to the currently focused element unless `target` is set.",
    ),
  target: z
    .string()
    .optional()
    .describe(
      "Optional @ref of an element to focus before pressing the key (e.g. '@e5'). Omit to send the key to whatever is currently focused / the page.",
    ),
});

type Input = z.infer<typeof parameters>;

const outputSchema = z.object({
  tab: z.string(),
  pressed: z.literal(true),
  key: z.string(),
  /** Viewport-scoped a11y tree of the page AFTER the key press. Mirrors
   *  the shape of `snapshot({mode: "viewport"})`. Empty when the post-action
   *  capture failed (see `note`). */
  snapshot: z.string().optional(),
  refCount: z.number().optional(),
  url: z.string().optional(),
  belowFoldCount: z.number().optional(),
  hint: z.string().optional(),
  note: z.string().optional(),
});
type Output = z.infer<typeof outputSchema>;

export const pressKeyTool: BrowserTool<Input, Output> = {
  name: "pressKey",
  description:
    "Press a keyboard key or combo (e.g. 'Enter', 'Escape', 'Tab', 'ctrl+a', arrow keys). Sends the key to the focused element, or pass `target` (@ref) to focus an element first. Useful for closing modals (Escape), navigating lists (arrows), submitting (Enter), or page-level shortcuts. The response auto-attaches a viewport-scoped accessibility snapshot of the page AFTER the action so you can see the current state and pick the next ref without a follow-up snapshot call. Call snapshot explicitly when you need the full tree, a different scope, or the section below the fold.",
  parameters,
  outputSchema,
  execute: async ({ tab: handle, key, target }, ctx) => {
    const tab = await resolveTabOrThrow(ctx, handle);
    const tabId = tab.id;
    const previousUrl = tab.url ?? undefined;

    try {
      // The "agent is working" overlay's document-level key blocker swallows
      // CDP-dispatched keys when `cuaAgentActing` is false. Toggle passthrough
      // around focus + key dispatch so the keys reach the page. Mirrors
      // cua-loop.ts. No-op when no shield is mounted.
      console.debug(
        `[press-key] dispatch key="${key}" tab=${String(tabId)}` +
          (target ? ` target=${target}` : ""),
      );
      await setShieldPassthrough(ctx.driver, tabId, true);
      try {
        if (target) {
          await focusRef(ctx.driver, tabId, target);
        }
        // Split "ctrl+a" -> ["ctrl", "a"]; a bare key -> ["Enter"].
        const keys = key.split("+").map((k) => k.trim()).filter(Boolean);
        await dispatchKeyCombo(ctx.driver, tabId, keys);
      } finally {
        await setShieldPassthrough(ctx.driver, tabId, false);
      }
    } catch (err) {
      if (!isDetachError(err)) throw err;
      // A key (e.g. Enter) may trigger navigation that detaches the debugger.
    }

    // Refs are refreshed by the post-action snapshot's merge (see
    // ref-store.setRefs); no pre-action invalidation needed.

    // Best-effort settle for any navigation the key may have triggered.
    await new Promise((r) => setTimeout(r, 200));
    await ctx.driver.waitForLoad(tabId, 3000).catch(() => {});

    // If the key navigated to a different document, drop stale refs BEFORE
    // the snapshot's merge so old-page refs can't leak.
    await invalidateRefsIfNavigated(ctx.driver, tabId, previousUrl);

    let url = previousUrl ?? "";
    try {
      const fresh = await ctx.driver.getTab(tabId);
      url = fresh.url ?? url;
    } catch {
      // tab may have closed during the action — keep the stale url
    }

    // Auto-attach a fresh VIEWPORT-scoped snapshot in place of a diff. See
    // click-element.ts for the full rationale.
    try {
      const cap = await captureSnapshot(ctx.driver, tabId, {
        mode: "interactive",
        viewportOnly: true,
      });
      const result: Output = {
        tab: handle,
        pressed: true,
        key,
        snapshot: cap.snapshotText,
        refCount: cap.refs.size,
        url,
      };
      if (cap.belowFoldCount > 0) {
        result.belowFoldCount = cap.belowFoldCount;
        result.hint = `${cap.belowFoldCount} more interactive element(s) are below the fold. Use scrollPage + snapshot to see them.`;
      }
      // Surface cross-extension frame exclusion (e.g. password-manager
      // iframes) so the agent knows the snapshot isn't whole-tree.
      if (cap.note) result.note = cap.note;
      return result;
    } catch (err) {
      return {
        tab: handle,
        pressed: true,
        key,
        url,
        note: `Key press succeeded but post-action snapshot failed: ${
          err instanceof Error ? err.message : String(err)
        }. Call snapshot to retry.`,
      };
    }
  },
};

async function focusRef(
  driver: BrowserDriver,
  tabId: TabId,
  ref: string,
): Promise<void> {
  const entry = getRef(tabId, ref);
  if (!entry) {
    throw new Error(
      `Ref ${ref} not found. Refs may be stale — call snapshot to refresh.`,
    );
  }
  // Re-resolve by identity tuple (role, name, nth) if the cached
  // backendNodeId is detached after a re-render.
  // We scrollIntoViewIfNeeded BEFORE DOM.focus because focus alone does not
  // scroll, and a subsequent CDP key dispatch only delivers to the visible
  // viewport. Mirrors typeByRef in type-in-element.ts.
  let backendNodeId = entry.backendNodeId;
  await scrollIntoViewIfNeeded(driver, tabId, backendNodeId);
  try {
    await driver.sendCommand(tabId, "DOM.focus", { backendNodeId });
  } catch (err) {
    const freshId = await findNodeByRoleNameNth(
      driver,
      tabId,
      entry.role,
      entry.name,
      entry.nth,
      entry.frameId,
    );
    if (freshId == null || freshId === backendNodeId) throw err;
    backendNodeId = freshId;
    await scrollIntoViewIfNeeded(driver, tabId, backendNodeId);
    await driver.sendCommand(tabId, "DOM.focus", { backendNodeId });
  }
}

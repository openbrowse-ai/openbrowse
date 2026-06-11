import { z } from "zod";
import { isDetachError } from "../cdp-errors";
import type { BrowserDriver, TabId } from "../driver";
import { resolveTabOrThrow } from "../driver";
import {
  getRef,
  getPreviousSnapshot,
  getPreviousSignals,
  invalidateRefsIfNavigated,
} from "../ref-store";
import { dispatchKeyCombo } from "../keyboard";
import { captureSnapshot, diffSnapshots, findNodeByRoleNameNth } from "../snapshot-capture";
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
  diff: z.string().nullable().optional(),
  note: z.string().optional(),
});
type Output = z.infer<typeof outputSchema>;

export const pressKeyTool: BrowserTool<Input, Output> = {
  name: "pressKey",
  description:
    "Press a keyboard key or combo (e.g. 'Enter', 'Escape', 'Tab', 'ctrl+a', arrow keys). Sends the key to the focused element, or pass `target` (@ref) to focus an element first. Useful for closing modals (Escape), navigating lists (arrows), submitting (Enter), or page-level shortcuts. The response includes a diff of what changed — use it to verify the key had an effect before pressing again.",
  parameters,
  outputSchema,
  execute: async ({ tab: handle, key, target }, ctx) => {
    const tab = await resolveTabOrThrow(ctx, handle);
    const tabId = tab.id;

    const previousSnapshot = getPreviousSnapshot(tabId);
    const previousSignals = getPreviousSignals(tabId);

    try {
      if (target) {
        await focusRef(ctx.driver, tabId, target);
      }
      // Split "ctrl+a" -> ["ctrl", "a"]; a bare key -> ["Enter"].
      const keys = key.split("+").map((k) => k.trim()).filter(Boolean);
      await dispatchKeyCombo(ctx.driver, tabId, keys);
    } catch (err) {
      if (!isDetachError(err)) throw err;
      // A key (e.g. Enter) may trigger navigation that detaches the debugger.
    }

    // Refs are refreshed by the post-action snapshot's merge (see
    // ref-store.setRefs); no pre-action invalidation needed.

    // Best-effort settle for any navigation the key may have triggered.
    await new Promise((r) => setTimeout(r, 200));
    await ctx.driver.waitForLoad(tabId, 3000).catch(() => {});

    if (!previousSnapshot || !previousSignals) {
      try {
        await captureSnapshot(ctx.driver, tabId);
      } catch {
        // page may have navigated away / tab closed; ignore
      }
      return { tab: handle, pressed: true, key };
    }

    try {
      // If the key (e.g. Enter) navigated to a different document, drop the
      // stale ref map BEFORE the snapshot's merge so old-page refs can't leak —
      // mirrors navigate.ts. Same-URL re-renders keep the carry-over.
      await invalidateRefsIfNavigated(ctx.driver, tabId, previousSignals.url);
      const { snapshotText, signals } = await captureSnapshot(ctx.driver, tabId);
      const diff = diffSnapshots(
        { text: previousSnapshot, signals: previousSignals },
        { text: snapshotText, signals },
      );
      if (diff === null) {
        return {
          tab: handle,
          pressed: true,
          key,
          diff: null,
          note:
            "Accessibility tree and element state unchanged. This may still " +
            "have succeeded (some changes aren't reflected here). Do NOT " +
            "blindly repeat the key — verify with a screenshot or by reading " +
            "element state before retrying.",
        };
      }
      return { tab: handle, pressed: true, key, diff };
    } catch (err) {
      return {
        tab: handle,
        pressed: true,
        key,
        note: `Key press succeeded but post-action snapshot failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
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
  let backendNodeId = entry.backendNodeId;
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
    await driver.sendCommand(tabId, "DOM.focus", { backendNodeId });
  }
}

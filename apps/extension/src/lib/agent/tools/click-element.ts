import { z } from "zod";
import { isDetachError } from "../cdp-errors";
import type { BrowserDriver, TabId } from "../driver";
import { resolveTabOrThrow } from "../driver";
import {
  getRef,
  getPreviousSnapshot,
  getPreviousSignals,
} from "../ref-store";
import {
  captureSnapshot,
  diffSnapshots,
  findNodeByRoleNameNth,
} from "../snapshot-capture";
import type { BrowserTool } from "../types";

const parameters = z.object({
  tab: z
    .string()
    .describe(
      "Tab handle to click in (e.g. 't1'). See the `## Tabs in this conversation` section of the system prompt, or call listTabs.",
    ),
  target: z
    .string()
    .describe(
      "Element to click. Use @ref from snapshot (e.g. '@e3') or a CSS selector as fallback.",
    ),
});

type Input = z.infer<typeof parameters>;

const outputSchema = z.object({
  tab: z.string(),
  clicked: z.literal(true),
  target: z.string(),
  diff: z.string().nullable().optional(),
  note: z.string().optional(),
});
type Output = z.infer<typeof outputSchema>;

export const clickElementTool: BrowserTool<Input, Output> = {
  name: "clickElement",
  description:
    "Click an element on a page. Pass `tab` (handle from the tab legend or listTabs) and `target` — either an @ref from a recent snapshot of THAT tab (preferred) or a CSS selector as fallback. The response automatically includes a diff of what changed on the page — use it to verify the action worked before acting again. If diff is null the click produced no visible change.",
  parameters,
  outputSchema,
  execute: async ({ tab: handle, target }, ctx) => {
    const tab = await resolveTabOrThrow(ctx, handle);
    const tabId = tab.id;

    const previousSnapshot = getPreviousSnapshot(tabId);
    const previousSignals = getPreviousSignals(tabId);

    let hitWarning: string | undefined;
    try {
      if (target.startsWith("@e")) {
        ({ warning: hitWarning } = await clickByRef(ctx.driver, tabId, target));
      } else {
        await clickBySelector(ctx.driver, tabId, target);
      }
    } catch (err) {
      if (!isDetachError(err)) throw err;
    }

    // Note: we intentionally do NOT invalidate refs here. With content-stable
    // ref ids, the post-action snapshot below merges fresh backendNodeIds over
    // the existing map (see ref-store.setRefs), so refs the agent still holds
    // keep resolving. Hard-deleting would needlessly drop the carry-over pool.

    // Best-effort settle: wait briefly for any navigation the click may have
    // triggered. If nothing happens, this times out silently and we move on.
    await new Promise((r) => setTimeout(r, 250));
    await ctx.driver.waitForLoad(tabId, 3000).catch(() => {});

    // Auto-attach diff so the agent can verify the outcome without a follow-up
    // snapshot call. If we have no prior baseline, capture fresh and bail.
    if (!previousSnapshot || !previousSignals) {
      try {
        await captureSnapshot(ctx.driver, tabId);
      } catch {
        // page may have navigated away / tab closed; ignore
      }
      return { tab: handle, clicked: true, target, ...(hitWarning && { note: hitWarning }) };
    }

    try {
      const { snapshotText, signals } = await captureSnapshot(ctx.driver, tabId);
      const diff = diffSnapshots(
        { text: previousSnapshot, signals: previousSignals },
        { text: snapshotText, signals },
      );
      if (diff === null) {
        return {
          tab: handle,
          clicked: true,
          target,
          diff: null,
          note:
            (hitWarning ? hitWarning + " " : "") +
            "Accessibility tree and element state unchanged. This may still " +
            "have succeeded (some changes aren't reflected here). Do NOT " +
            "blindly re-click — verify with a screenshot or by reading " +
            "element state before retrying.",
        };
      }
      return { tab: handle, clicked: true, target, diff, ...(hitWarning && { note: hitWarning }) };
    } catch (err) {
      return {
        tab: handle,
        clicked: true,
        target,
        note:
          (hitWarning ? hitWarning + " " : "") +
          `Click succeeded but post-action snapshot failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
      };
    }
  },
};

async function clickByRef(
  driver: BrowserDriver,
  tabId: TabId,
  ref: string,
): Promise<{ warning?: string }> {
  const entry = getRef(tabId, ref);
  if (!entry) {
    throw new Error(
      `Ref ${ref} not found. Refs may be stale — call snapshot to refresh.`,
    );
  }

  // Resolve the element's box. On a re-rendered page the cached backendNodeId
  // may point at a detached node. Recover by re-finding the SAME logical
  // element via its stable identity tuple (role, name, nth) from a fresh AX
  // tree — this survives even a changed display name (where the content-hash
  // ref would differ), matching agent-browser's resolution model.
  let backendNodeId = entry.backendNodeId;
  let boxResult = await getBoxModel(driver, tabId, backendNodeId);
  if (!boxResult) {
    const freshId = await findNodeByRoleNameNth(
      driver,
      tabId,
      entry.role,
      entry.name,
      entry.nth,
      entry.frameId,
    );
    if (freshId != null && freshId !== backendNodeId) {
      backendNodeId = freshId;
      boxResult = await getBoxModel(driver, tabId, backendNodeId);
    }
  }

  if (!boxResult) {
    throw new Error(
      `Could not get position for ${ref}. Element may be hidden or removed.`,
    );
  }

  const pts = boxResult;
  const x = (pts[0] + pts[2] + pts[4] + pts[6]) / 4;
  const y = (pts[1] + pts[3] + pts[5] + pts[7]) / 4;

  const warning = await verifyHitTarget(
    driver,
    tabId,
    x,
    y,
    backendNodeId,
    ref,
  );

  await driver.sendCommand(tabId, "Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x,
    y,
  });
  await driver.sendCommand(tabId, "Input.dispatchMouseEvent", {
    type: "mousePressed",
    x,
    y,
    button: "left",
    clickCount: 1,
  });
  await driver.sendCommand(tabId, "Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x,
    y,
    button: "left",
    clickCount: 1,
  });

  return { warning };
}

/**
 * Fetch the box-model content quad for a backend node, or null when the node
 * can't be resolved (detached / removed). Never throws.
 */
async function getBoxModel(
  driver: BrowserDriver,
  tabId: TabId,
  backendNodeId: number,
): Promise<number[] | null> {
  try {
    const boxResult = await driver.sendCommand<{
      model?: { content: number[] };
    }>(tabId, "DOM.getBoxModel", { backendNodeId });
    return boxResult.model?.content ?? null;
  } catch {
    return null;
  }
}

async function clickBySelector(
  driver: BrowserDriver,
  tabId: TabId,
  selector: string,
): Promise<void> {
  const result = await driver.sendToContentScript<{
    success: boolean;
    error?: string;
  }>(tabId, {
    type: "CHAT_CLICK_ELEMENT",
    selector,
  });

  if (!result.success)
    throw new Error(result.error ?? `No element found for: ${selector}`);
}

/**
 * Best-effort hit test: ask the page which element is topmost at the click
 * point. If it is not the intended element, the click is probably being
 * intercepted by an overlay (cookie banner, modal backdrop, sticky header).
 * We never block — we return a human-readable warning the tool attaches to
 * its `note` so the model can react (dismiss the overlay, scroll, screenshot).
 *
 * Returns undefined when the target is at the point, or when the hit test
 * could not be performed (degrade silently rather than block a valid click).
 *
 * NOTE: a click landing on a DESCENDANT of the target (e.g. an <svg> inside a
 * <button>) also reports a mismatch and warns. That is an accepted tradeoff:
 * we do not perform ancestry checks (expensive over CDP) and prefer a soft
 * false-positive warning over blocking a valid click.
 */
async function verifyHitTarget(
  driver: BrowserDriver,
  tabId: TabId,
  x: number,
  y: number,
  targetBackendNodeId: number,
  ref: string,
): Promise<string | undefined> {
  try {
    const hit = await driver.sendCommand<{ backendNodeId?: number }>(
      tabId,
      "DOM.getNodeForLocation",
      { x: Math.round(x), y: Math.round(y) },
    );
    const hitId = hit.backendNodeId;
    if (hitId == null || hitId === targetBackendNodeId) return undefined;

    let desc = `backendNodeId ${hitId}`;
    try {
      const d = await driver.sendCommand<{
        node?: { nodeName?: string; attributes?: string[] };
      }>(tabId, "DOM.describeNode", { backendNodeId: hitId });
      desc = formatNodeDescription(d.node) ?? desc;
    } catch {
      // keep the bare id
    }

    return (
      `The element at the click point for ${ref} is "${desc}", not the ` +
      `intended element — an overlay may be intercepting the click. The ` +
      `click was still dispatched; verify with a screenshot, and if it had ` +
      `no effect, dismiss the overlay (e.g. close a cookie/consent banner or ` +
      `modal) or scroll the target into the clear before retrying.`
    );
  } catch {
    // Hit test unavailable (e.g. cross-origin frame, CDP error) — do not block.
    return undefined;
  }
}

/**
 * Turn a DOM.describeNode result into a short label like `div.cookie-banner`,
 * `button#submit`, or `a[aria-label="Close"]`. `attributes` is a flat
 * [name, value, name, value, ...] array per CDP.
 */
function formatNodeDescription(
  node: { nodeName?: string; attributes?: string[] } | undefined,
): string | undefined {
  if (!node?.nodeName) return undefined;
  const tag = node.nodeName.toLowerCase();
  const attrs = node.attributes ?? [];
  const get = (name: string): string | undefined => {
    for (let i = 0; i + 1 < attrs.length; i += 2) {
      if (attrs[i] === name) return attrs[i + 1];
    }
    return undefined;
  };
  const id = get("id");
  if (id) return `${tag}#${id}`;
  const cls = get("class");
  if (cls) return `${tag}.${cls.split(/\s+/)[0]}`;
  const label = get("aria-label");
  if (label) return `${tag}[aria-label="${label}"]`;
  return tag;
}

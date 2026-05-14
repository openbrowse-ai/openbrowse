import { z } from "zod";
import { getActiveUserTab, sendToContentScript, waitForTabLoad } from "../active-tab";
import { sendCommand } from "../cdp-session";
import { getRef, getPreviousSnapshot, invalidateRefs } from "../ref-store";
import { captureSnapshot, diffSnapshots } from "../snapshot-capture";
import type { BrowserTool } from "../types";

const parameters = z.object({
  target: z
    .string()
    .describe(
      "Element to click. Use @ref from snapshot (e.g. '@e3') or a CSS selector as fallback.",
    ),
});

type Input = z.infer<typeof parameters>;

type Output = {
  clicked: true;
  target: string;
  diff?: string | null;
  note?: string;
};

export const clickElementTool: BrowserTool<Input, Output> = {
  name: "clickElement",
  description:
    "Click an element on the page. Use @ref from snapshot (preferred) or a CSS selector. The response automatically includes a diff of what changed on the page — use it to verify the action worked before acting again. If diff is null the click produced no visible change.",
  parameters,
  execute: async ({ target }) => {
    const tab = await getActiveUserTab();
    const tabId = tab.id!;

    const previousSnapshot = getPreviousSnapshot(tabId);

    if (target.startsWith("@e")) {
      await clickByRef(tabId, target);
    } else {
      await clickBySelector(tabId, target);
    }

    invalidateRefs(tabId);

    // Best-effort settle: wait briefly for any navigation the click may have
    // triggered. If nothing happens, this times out silently and we move on.
    await new Promise((r) => setTimeout(r, 250));
    await waitForTabLoad(tabId, 3000).catch(() => {});

    // Auto-attach diff so the agent can verify the outcome without a follow-up
    // snapshot call. If previousSnapshot is null, we skip diff and just return
    // the fresh snapshot implicitly via the setRefs side-effect.
    if (!previousSnapshot) {
      try {
        await captureSnapshot(tabId);
      } catch {
        // page may have navigated away / tab closed; ignore
      }
      return { clicked: true, target };
    }

    try {
      const { snapshotText } = await captureSnapshot(tabId);
      const diff = diffSnapshots(previousSnapshot, snapshotText);
      if (diff === null) {
        return {
          clicked: true,
          target,
          diff: null,
          note: "No visible page change detected. The click may not have had the expected effect.",
        };
      }
      return { clicked: true, target, diff };
    } catch (err) {
      return {
        clicked: true,
        target,
        note: `Click succeeded but post-action snapshot failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      };
    }
  },
};

async function clickByRef(tabId: number, ref: string): Promise<void> {
  const entry = getRef(tabId, ref);
  if (!entry) {
    throw new Error(
      `Ref ${ref} not found. Refs may be stale — call snapshot to refresh.`,
    );
  }

  const boxResult = await sendCommand<{
    model?: { content: number[] };
  }>(tabId, "DOM.getBoxModel", { backendNodeId: entry.backendNodeId });

  if (!boxResult.model?.content) {
    throw new Error(`Could not get position for ${ref}. Element may be hidden or removed.`);
  }

  const pts = boxResult.model.content;
  const x = (pts[0] + pts[2] + pts[4] + pts[6]) / 4;
  const y = (pts[1] + pts[3] + pts[5] + pts[7]) / 4;

  await sendCommand(tabId, "Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x,
    y,
  });
  await sendCommand(tabId, "Input.dispatchMouseEvent", {
    type: "mousePressed",
    x,
    y,
    button: "left",
    clickCount: 1,
  });
  await sendCommand(tabId, "Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x,
    y,
    button: "left",
    clickCount: 1,
  });
}

async function clickBySelector(tabId: number, selector: string): Promise<void> {
  const result = await sendToContentScript<{
    success: boolean;
    error?: string;
  }>(tabId, {
    type: "CHAT_CLICK_ELEMENT",
    selector,
  });

  if (!result.success)
    throw new Error(result.error ?? `No element found for: ${selector}`);
}

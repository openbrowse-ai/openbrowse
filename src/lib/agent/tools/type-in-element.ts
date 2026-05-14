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
      "Element to type into. Use @ref from snapshot (e.g. '@e5') or a CSS selector as fallback.",
    ),
  text: z.string().describe("The text to type into the element"),
  clearFirst: z
    .boolean()
    .optional()
    .describe("Whether to clear existing text before typing (default: true)"),
  submit: z
    .boolean()
    .optional()
    .describe(
      "Press Enter after typing to submit the form and wait for navigation/settle. Prefer this over appending \\n to text.",
    ),
});

type Input = z.infer<typeof parameters>;

type Output = {
  typed: true;
  target: string;
  text: string;
  submitted?: boolean;
  diff?: string | null;
  note?: string;
};

export const typeInElementTool: BrowserTool<Input, Output> = {
  name: "typeInElement",
  description:
    "Type text into an input or textarea. Use @ref from snapshot (preferred) or a CSS selector. Pass submit: true to press Enter and wait for the page to settle. The response automatically includes a diff of what changed on the page.",
  parameters,
  execute: async ({ target, text, clearFirst, submit }) => {
    const tab = await getActiveUserTab();
    const tabId = tab.id!;

    const previousSnapshot = getPreviousSnapshot(tabId);

    // Back-compat: trailing newline was the old form-submit hack.
    const legacyNewlineSubmit = text.endsWith("\n");
    const textToType = legacyNewlineSubmit ? text.slice(0, -1) : text;
    const shouldPressEnter = submit ?? legacyNewlineSubmit;

    if (target.startsWith("@e")) {
      await typeByRef(tabId, target, textToType, clearFirst ?? true);
    } else {
      await typeBySelector(tabId, target, textToType, clearFirst ?? true);
    }

    if (shouldPressEnter) {
      await sendCommand(tabId, "Input.dispatchKeyEvent", {
        type: "keyDown",
        key: "Enter",
        code: "Enter",
        windowsVirtualKeyCode: 13,
        nativeVirtualKeyCode: 13,
      });
      await sendCommand(tabId, "Input.dispatchKeyEvent", {
        type: "keyUp",
        key: "Enter",
        code: "Enter",
        windowsVirtualKeyCode: 13,
        nativeVirtualKeyCode: 13,
      });

      await new Promise((r) => setTimeout(r, 200));
      await waitForTabLoad(tabId, 8000).catch(() => {});
    }

    invalidateRefs(tabId);

    const baseResult = {
      typed: true as const,
      target,
      text,
      ...(shouldPressEnter && { submitted: true as const }),
    };

    if (!previousSnapshot) {
      try {
        await captureSnapshot(tabId);
      } catch {}
      return baseResult;
    }

    try {
      const { snapshotText } = await captureSnapshot(tabId);
      const diff = diffSnapshots(previousSnapshot, snapshotText);
      if (diff === null) {
        return {
          ...baseResult,
          diff: null,
          note: "No visible page change detected after typing. The element may not have accepted input.",
        };
      }
      return { ...baseResult, diff };
    } catch (err) {
      return {
        ...baseResult,
        note: `Type succeeded but post-action snapshot failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      };
    }
  },
};

async function typeByRef(
  tabId: number,
  ref: string,
  text: string,
  clearFirst: boolean,
): Promise<void> {
  const entry = getRef(tabId, ref);
  if (!entry) {
    throw new Error(
      `Ref ${ref} not found. Refs may be stale — call snapshot to refresh.`,
    );
  }

  await sendCommand(tabId, "DOM.focus", { backendNodeId: entry.backendNodeId });

  if (clearFirst) {
    await sendCommand(tabId, "Input.dispatchKeyEvent", {
      type: "keyDown",
      key: "a",
      code: "KeyA",
      modifiers: 2, // Ctrl
    });
    await sendCommand(tabId, "Input.dispatchKeyEvent", {
      type: "keyUp",
      key: "a",
      code: "KeyA",
      modifiers: 2,
    });
    await sendCommand(tabId, "Input.dispatchKeyEvent", {
      type: "keyDown",
      key: "Backspace",
      code: "Backspace",
    });
    await sendCommand(tabId, "Input.dispatchKeyEvent", {
      type: "keyUp",
      key: "Backspace",
      code: "Backspace",
    });
  }

  await sendCommand(tabId, "Input.insertText", { text });
}

async function typeBySelector(
  tabId: number,
  selector: string,
  text: string,
  clearFirst: boolean,
): Promise<void> {
  const result = await sendToContentScript<{
    success: boolean;
    error?: string;
  }>(tabId, {
    type: "CHAT_TYPE_IN_ELEMENT",
    selector,
    text,
    clearFirst,
  });

  if (!result.success)
    throw new Error(result.error ?? `No element found for: ${selector}`);
}

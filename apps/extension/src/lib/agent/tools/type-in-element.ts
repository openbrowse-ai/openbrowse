import { z } from "zod";
import { isDetachError } from "../cdp-errors";
import { setShieldPassthrough } from "../click-diagnostic";
import type { BrowserDriver, TabId } from "../driver";
import { resolveTabOrThrow } from "../driver";
import {
  getRef,
  invalidateRefsIfNavigated,
} from "../ref-store";
import {
  captureSnapshot,
  findNodeByRoleNameNth,
} from "../snapshot-capture";
import { scrollIntoViewIfNeeded } from "../viewport";
import type { BrowserTool } from "../types";

const parameters = z.object({
  tab: z
    .string()
    .describe(
      "Tab handle to type in (e.g. 't1'). See the `## Tabs in this conversation` section of the system prompt, or call listTabs.",
    ),
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

const outputSchema = z.object({
  tab: z.string(),
  typed: z.literal(true),
  target: z.string(),
  text: z.string(),
  submitted: z.boolean().optional(),
  /** Viewport-scoped a11y tree of the page AFTER the type/submit. Mirrors
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

export const typeInElementTool: BrowserTool<Input, Output> = {
  name: "typeInElement",
  description:
    "Type text into an input or textarea. Pass `tab` (handle from the tab legend or listTabs) and `target` — either an @ref from a recent snapshot of THAT tab (preferred) or a CSS selector as fallback. Pass submit: true to press Enter and wait for the page to settle. The response auto-attaches a viewport-scoped accessibility snapshot of the page AFTER the action so you can see the current state and pick the next ref without a follow-up snapshot call. Call snapshot explicitly when you need the full tree, a different scope, or the section below the fold.",
  parameters,
  outputSchema,
  execute: async ({ tab: handle, target, text, clearFirst, submit }, ctx) => {
    const tab = await resolveTabOrThrow(ctx, handle);
    const tabId = tab.id;
    const previousUrl = tab.url ?? undefined;

    // Back-compat: trailing newline was the old form-submit hack.
    const legacyNewlineSubmit = text.endsWith("\n");
    const textToType = legacyNewlineSubmit ? text.slice(0, -1) : text;
    const shouldPressEnter = submit ?? legacyNewlineSubmit;

    try {
      console.debug(
        `[type-tool] dispatch target=${target} tab=${String(tabId)}` +
          (shouldPressEnter ? " (+Enter)" : ""),
      );
      // Refs go through CDP `Input.dispatchKeyEvent` and need the shield's
      // key blocker in passthrough; selector path uses content-script
      // `el.value =` (synthetic) and doesn't. Toggle passthrough only
      // around the CDP path(s).
      const usingCdp = target.startsWith("@e");
      if (usingCdp) {
        await setShieldPassthrough(ctx.driver, tabId, true);
      }
      try {
        if (usingCdp) {
          await typeByRef(ctx.driver, tabId, target, textToType, clearFirst ?? true);
        } else {
          await typeBySelector(ctx.driver, tabId, target, textToType, clearFirst ?? true);
        }
      } finally {
        if (usingCdp) {
          await setShieldPassthrough(ctx.driver, tabId, false);
        }
      }

      if (shouldPressEnter) {
        // Enter is dispatched via CDP regardless of which type path ran —
        // toggle passthrough specifically for it. Doing this in a separate
        // window (instead of one big window around both type AND Enter)
        // means the selector path doesn't pay the toggle round-trip when
        // submit is false.
        await setShieldPassthrough(ctx.driver, tabId, true);
        try {
          await ctx.driver.sendCommand(tabId, "Input.dispatchKeyEvent", {
            type: "keyDown",
            key: "Enter",
            code: "Enter",
            windowsVirtualKeyCode: 13,
            nativeVirtualKeyCode: 13,
          });
          await ctx.driver.sendCommand(tabId, "Input.dispatchKeyEvent", {
            type: "keyUp",
            key: "Enter",
            code: "Enter",
            windowsVirtualKeyCode: 13,
            nativeVirtualKeyCode: 13,
          });
        } finally {
          await setShieldPassthrough(ctx.driver, tabId, false);
        }
      }
    } catch (err) {
      if (!isDetachError(err)) throw err;
      // If typing or pressing Enter triggered a navigation that detached the debugger,
      // it means the submission successfully triggered a navigation.
    }

    if (shouldPressEnter) {
      // Wait for any navigation the Enter key may have triggered to settle.
      // The Enter dispatch itself happened inside the try block above; this
      // post-action block is purely settle/wait, no second dispatch.
      await new Promise((r) => setTimeout(r, 200));
      await ctx.driver.waitForLoad(tabId, 8000).catch(() => {});
    }

    // Refs are refreshed (not invalidated) by the post-action snapshot's
    // merge — see click-element.ts and ref-store.setRefs.
    await invalidateRefsIfNavigated(ctx.driver, tabId, previousUrl);

    const baseResult: Output = {
      tab: handle,
      typed: true as const,
      target,
      text,
      ...(shouldPressEnter && { submitted: true as const }),
    };

    let url = previousUrl ?? "";
    try {
      const fresh = await ctx.driver.getTab(tabId);
      url = fresh.url ?? url;
    } catch {
      // tab may have closed during the action — keep the stale url
    }
    baseResult.url = url;

    // Auto-attach a fresh VIEWPORT-scoped snapshot in place of a diff. See
    // click-element.ts for the full rationale; in short: diffing prior
    // (often viewport-scoped) snapshots against full-tree post-action
    // snapshots was hallucinating "[+] entire below-fold tree" lines and
    // confusing the model.
    try {
      const cap = await captureSnapshot(ctx.driver, tabId, {
        mode: "interactive",
        viewportOnly: true,
      });
      baseResult.snapshot = cap.snapshotText;
      baseResult.refCount = cap.refs.size;
      if (cap.belowFoldCount > 0) {
        baseResult.belowFoldCount = cap.belowFoldCount;
        baseResult.hint = `${cap.belowFoldCount} more interactive element(s) are below the fold. Use scrollPage + snapshot to see them.`;
      }
      // Surface cross-extension frame exclusion (e.g. password-manager
      // iframes) so the agent knows the snapshot isn't whole-tree.
      if (cap.note) baseResult.note = cap.note;
      return baseResult;
    } catch (err) {
      return {
        ...baseResult,
        note: `Type succeeded but post-action snapshot failed: ${
          err instanceof Error ? err.message : String(err)
        }. Call snapshot to retry.`,
      };
    }
  },
};

async function typeByRef(
  driver: BrowserDriver,
  tabId: TabId,
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

  // Focus the element. On a re-rendered page the cached backendNodeId may be
  // detached; recover by re-finding the same logical element via its identity
  // tuple (role, name, nth) from a fresh AX tree before failing.
  // We scrollIntoViewIfNeeded BEFORE DOM.focus because focus alone does not
  // scroll (and the subsequent CDP key dispatch only delivers to the visible
  // viewport — an off-screen focus + insertText would no-op visually even
  // though the value gets set, hiding the cursor + caret animation that
  // tests rely on for confirmation).
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

  if (clearFirst) {
    await driver.sendCommand(tabId, "Input.dispatchKeyEvent", {
      type: "keyDown",
      key: "a",
      code: "KeyA",
      modifiers: 2, // Ctrl
    });
    await driver.sendCommand(tabId, "Input.dispatchKeyEvent", {
      type: "keyUp",
      key: "a",
      code: "KeyA",
      modifiers: 2,
    });
    await driver.sendCommand(tabId, "Input.dispatchKeyEvent", {
      type: "keyDown",
      key: "Backspace",
      code: "Backspace",
    });
    await driver.sendCommand(tabId, "Input.dispatchKeyEvent", {
      type: "keyUp",
      key: "Backspace",
      code: "Backspace",
    });
  }

  await driver.sendCommand(tabId, "Input.insertText", { text });
}

async function typeBySelector(
  driver: BrowserDriver,
  tabId: TabId,
  selector: string,
  text: string,
  clearFirst: boolean,
): Promise<void> {
  const result = await driver.sendToContentScript<{
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

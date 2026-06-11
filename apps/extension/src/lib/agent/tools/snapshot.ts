import { z } from "zod";
import type { BrowserTool } from "../types";
import { resolveTabOrThrow } from "../driver";
import { captureSnapshot, diffSnapshots } from "../snapshot-capture";

const parameters = z.object({
  tab: z
    .string()
    .describe(
      "Tab handle to snapshot (e.g. 't1'). See the `## Tabs in this conversation` section of the system prompt, or call listTabs.",
    ),
  mode: z
    .enum(["interactive", "full", "viewport"])
    .optional()
    .describe(
      "'interactive' (default) = all actionable elements; 'full' = complete tree including text content; 'viewport' = only interactive elements currently above the fold (use on heavy pages like Amazon/Gmail/Notion for dramatic token savings).",
    ),
  selector: z
    .string()
    .optional()
    .describe(
      "CSS selector to scope the snapshot to a subtree (e.g. 'main', '#content')",
    ),
  diff: z
    .boolean()
    .optional()
    .describe("Return only changes since last snapshot for this tab"),
});

type Input = z.infer<typeof parameters>;
const outputSchema = z.object({
  tab: z.string(),
  snapshot: z.string(),
  refCount: z.number(),
  url: z.string(),
  belowFoldCount: z.number().optional(),
  hint: z.string().optional(),
});
type Output = z.infer<typeof outputSchema>;

export const snapshotTool: BrowserTool<Input, Output> = {
  name: "snapshot",
  description:
    "Get a tab's accessibility tree with @refs for interactive elements. Pass `tab` (handle from the tab legend or listTabs). Use refs with clickElement/typeInElement. On heavy pages, scope with `selector` or use `mode: 'viewport'` to see only above-the-fold elements. Action tools (click/type/navigate) already auto-attach diffs — call this explicitly only when you need the full tree, a scoped view, or after executeOnPage.",
  parameters,
  outputSchema,
  execute: async ({ tab: handle, mode, selector, diff }, ctx) => {
    const tab = await resolveTabOrThrow(ctx, handle);
    const tabId = tab.id;
    const url = tab.url ?? "";

    const viewportOnly = mode === "viewport";
    const captureMode = mode === "viewport" ? "interactive" : mode;

    const { snapshotText, refs, previous, signals, previousSignals, belowFoldCount } =
      await captureSnapshot(ctx.driver, tabId, {
        mode: captureMode,
        selector,
        viewportOnly,
      });

    const baseResult: Output = {
      tab: handle,
      snapshot:
        diff && previous && previousSignals
          ? (diffSnapshots(
              { text: previous, signals: previousSignals },
              { text: snapshotText, signals },
            ) ?? "(no changes)")
          : snapshotText,
      refCount: refs.size,
      url,
    };

    if (belowFoldCount > 0) {
      baseResult.belowFoldCount = belowFoldCount;
      baseResult.hint = viewportOnly
        ? `${belowFoldCount} more interactive element(s) are below the fold. Use scrollPage + snapshot to see them.`
        : `${belowFoldCount} of the returned refs are below the fold — scrolling may reveal additional interactive elements beyond the current tree.`;
    }

    return baseResult;
  },
};

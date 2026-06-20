import { z } from "zod";
import { isDetachError } from "../cdp-errors";
import { readNetwork } from "../cdp-capture";
import {
  runClickDiagnostic,
  setShieldPassthrough,
} from "../click-diagnostic";
import type { BrowserDriver, TabId } from "../driver";
import { resolveTabOrThrow } from "../driver";
import {
  getRef,
  invalidateRefsIfNavigated,
} from "../ref-store";
import {
  readElementGeometry,
  readViewportMetrics,
  scrollIntoViewIfNeeded,
  waitForLayoutFlush,
} from "../viewport";
import {
  captureSnapshot,
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
  /** Viewport-scoped a11y tree of the page AFTER the click. Mirrors the
   *  shape of `snapshot({mode: "viewport"})`. Empty when the post-action
   *  capture failed (see `note`). */
  snapshot: z.string().optional(),
  refCount: z.number().optional(),
  url: z.string().optional(),
  belowFoldCount: z.number().optional(),
  hint: z.string().optional(),
  note: z.string().optional(),
});
type Output = z.infer<typeof outputSchema>;

export const clickElementTool: BrowserTool<Input, Output> = {
  name: "clickElement",
  description:
    "Click an element on a page. Pass `tab` (handle from the tab legend or listTabs) and `target` — either an @ref from a recent snapshot of THAT tab (preferred) or a CSS selector as fallback. The response auto-attaches a viewport-scoped accessibility snapshot of the page AFTER the click so you can see the current state and pick the next ref without a follow-up snapshot call. Call snapshot explicitly when you need the full tree, a different scope, or the section below the fold.",
  parameters,
  outputSchema,
  execute: async ({ tab: handle, target }, ctx) => {
    const tab = await resolveTabOrThrow(ctx, handle);
    const tabId = tab.id;
    const previousUrl = tab.url ?? undefined;

    // Effect-detection mark: capture a "before" timestamp BEFORE the click
    // dispatches so we can later filter the cdp-capture network buffer
    // down to "requests caused by THIS click." Used below to suppress the
    // soft `hitWarning` (overlay-intercept) when we have positive evidence
    // the click had an effect (URL change or any network activity), since
    // that warning is a frequent false positive on synthetic-component
    // sites where the click landed on a wrapper but the intended handler
    // still fired. Date.now() is fine here — `cdp-capture` stamps every
    // entry with the same wall-clock source.
    const preTs = Date.now();

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

    // If the click navigated to a different document, drop the stale ref map
    // (incl. the carry-over pool) BEFORE the post-action snapshot's merge so
    // old-page refs can't leak into the new page — mirrors navigate.ts.
    // In-page re-renders (same URL) keep the content-stable carry-over.
    await invalidateRefsIfNavigated(ctx.driver, tabId, previousUrl);

    // Capture a viewport-scoped snapshot of the post-action state. We auto-
    // attach this in place of a `diff` for two reasons:
    //   1. Diffs hallucinated when the prior snapshot was viewport-scoped
    //      and this post-action capture was full-tree — every below-fold
    //      element looked "added" to the model.
    //   2. The agent almost always needs to see the current viewport state
    //      to pick its next move (especially after scroll-triggering
    //      clicks like anchor links). Returning the snapshot directly is
    //      strictly more informative than returning a diff.
    let url = previousUrl ?? "";
    try {
      const fresh = await ctx.driver.getTab(tabId);
      url = fresh.url ?? url;
    } catch {
      // tab may have closed during the action — keep the stale url
    }

    // Effect detection: did the click do anything observable?
    //
    // The hit-test `hitWarning` is a soft "the click point was on a
    // different element" signal. It's a frequent false positive on
    // sites that wrap interactive controls in a presentational div
    // (most React/Vue/stencil component trees, modal backdrops that
    // overlap the trigger after the modal opens). Without a counter-
    // signal the agent treats the warning as a probable failure and
    // either re-screenshots or invents a workaround — wasting a turn
    // even though the click landed correctly.
    //
    // Counter-signals (any one suppresses the warning):
    //   - URL change: the click navigated.
    //   - Network activity post-`preTs`: the click triggered a request.
    //     Reuses the always-on cdp-capture ring buffer that the agent-
    //     transport pre-execute hook arms for every tab tool, so the
    //     check is free (no extra Chrome attach).
    //
    // When NEITHER fires AND the hit-test mismatched, we keep the
    // warning AND tighten its wording: now we have evidence the click
    // had no effect, so the agent should treat the note as actionable.
    //
    // (We deliberately don't use refCount/snapshot diff as a signal:
    // it'd require a pre-click snapshot, which we don't have, and
    // post-click DOM presence doesn't prove EFFECT — the page may have
    // been there before too. URL + network is sufficient.)
    const navigated = previousUrl !== undefined && previousUrl !== url;
    let networkActive = false;
    try {
      // `tabId` is the opaque BrowserDriver `TabId` (number | string).
      // cdp-capture's ring buffer keys on chrome ctids (numbers); the
      // extension driver always passes numbers here. Same cast pattern
      // used by the read_* tools for the same reason.
      const buf = readNetwork(tabId as number, { limit: 200 });
      networkActive = buf.captured && buf.requests.some((r) => r.ts >= preTs);
    } catch {
      // capture buffer unavailable — degrade silently. URL signal still applies.
    }
    const hadEffect = navigated || networkActive;
    // hitWarning gating:
    //   - had effect → drop the warning (false positive).
    //   - no effect AND warning present → keep, but tighten wording so
    //     the agent treats it as actionable rather than defensive noise.
    //   - no warning to begin with → nothing to emit.
    let effectiveHitWarning: string | undefined;
    if (hitWarning) {
      effectiveHitWarning = hadEffect
        ? undefined
        : `${hitWarning} (No URL change or network activity detected after the click — the click likely had no effect.)`;
    }
    try {
      const cap = await captureSnapshot(ctx.driver, tabId, {
        mode: "interactive",
        viewportOnly: true,
      });
      const result: Output = {
        tab: handle,
        clicked: true,
        target,
        snapshot: cap.snapshotText,
        refCount: cap.refs.size,
        url,
      };
      if (cap.belowFoldCount > 0) {
        result.belowFoldCount = cap.belowFoldCount;
        result.hint = `${cap.belowFoldCount} more interactive element(s) are below the fold. Use scrollPage + snapshot to see them.`;
      }
      // Merge per-call notes. `effectiveHitWarning` (overlay-intercept,
      // post-effect-detection) and `cap.note` (cross-extension frames
      // excluded from the snapshot) are both information the agent benefits
      // from; concatenate when both fire.
      const notes = [effectiveHitWarning, cap.note].filter(Boolean);
      if (notes.length > 0) result.note = notes.join(" ");
      return result;
    } catch (err) {
      return {
        tab: handle,
        clicked: true,
        target,
        url,
        note:
          (effectiveHitWarning ? effectiveHitWarning + " " : "") +
          `Click succeeded but post-action snapshot failed: ${
            err instanceof Error ? err.message : String(err)
          }. Call snapshot to retry.`,
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

  // ── Forensic geometry pass ─────────────────────────────────────────────
  // We capture the element's geometry FOUR ways to disambiguate the
  // off-viewport failures the diagnostic surfaced previously:
  //
  //   1. Pre-scroll  getBoxModel               (DOC space)
  //   2. Pre-scroll  getBoundingClientRect     (VIEWPORT space, atomic w/ scroll)
  //                  ↓ scrollIntoViewIfNeeded ↓
  //                  ↓ waitForLayoutFlush     ↓ (two rAFs — settle smooth-scroll)
  //   3. Post-scroll getBoxModel               (DOC space)
  //   4. Post-scroll getBoundingClientRect     (VIEWPORT space, atomic w/ scroll)
  //
  // Reads 2 and 4 also capture live `scrollY` and `innerHeight` IN THE SAME
  // FRAME as the rect, eliminating the inter-call race that
  // (getBoxModel → readViewportMetrics) was vulnerable to.
  //
  // The DISPATCHED click coordinates are taken from read #4 — the atomic
  // post-scroll viewport rect — which is correct by construction. Reads
  // 1–3 exist purely to log and confirm whether (a) scrollIntoViewIfNeeded
  // moved the page, (b) the box-model approach agrees with gBCR, and
  // (c) the layout-flush wait is needed.
  const preBox = boxResult;
  const preDocX = (preBox[0] + preBox[2] + preBox[4] + preBox[6]) / 4;
  const preDocY = (preBox[1] + preBox[3] + preBox[5] + preBox[7]) / 4;
  const preGeom = await readElementGeometry(driver, tabId, backendNodeId);

  // Scroll the element into view. CDP `Input.dispatchMouseEvent` only
  // dispatches into the visible viewport, so an element below the fold
  // otherwise receives a silent no-op click. Best-effort.
  await scrollIntoViewIfNeeded(driver, tabId, backendNodeId);
  // Two rAFs to flush layout + commit any smooth-scroll animation. Without
  // this wait, the post-scroll reads can return pre-scroll positions on
  // pages with `scroll-behavior: smooth` or scroll-snap.
  await waitForLayoutFlush(driver, tabId);

  const postBox = (await getBoxModel(driver, tabId, backendNodeId)) ?? preBox;
  const postDocX = (postBox[0] + postBox[2] + postBox[4] + postBox[6]) / 4;
  const postDocY = (postBox[1] + postBox[3] + postBox[5] + postBox[7]) / 4;
  const postGeom = await readElementGeometry(driver, tabId, backendNodeId);

  // Pick the click point. Prefer the atomic gBCR center (read #4) because
  // it's intrinsically scroll-consistent. Fall back to the legacy
  // box-model − scroll path so a debugger that doesn't support
  // `Runtime.callFunctionOn` (or a detached objectId) doesn't break clicks.
  let x: number;
  let y: number;
  let coordSource: "gbcr" | "boxmodel-fallback";
  // Resolved viewport metrics for the off-viewport guard and the dispatch
  // log. When gBCR succeeded these come from postGeom (atomic-with-rect);
  // when it failed we read them separately so the fallback still has truth-
  // ful innerWidth/Height instead of postGeom's zeroed sentinels.
  let scrollX = postGeom.scrollX;
  let scrollY = postGeom.scrollY;
  let innerW = postGeom.innerWidth;
  let innerH = postGeom.innerHeight;
  if (postGeom.ok) {
    x = postGeom.vx + postGeom.vw / 2;
    y = postGeom.vy + postGeom.vh / 2;
    coordSource = "gbcr";
  } else {
    // gBCR failed (detached objectId, debugger doesn't support
    // callFunctionOn, etc.). Read scroll/viewport SEPARATELY — falling
    // back to `postGeom.scrollX/Y` is wrong because they're zeroed-out
    // sentinels from `readElementGeometry`'s empty result, which would
    // make us dispatch at document coords and silently miss any element
    // that isn't at scroll(0,0). Mirrors the document↔viewport conversion
    // the gBCR path gets atomically.
    const vp = await readViewportMetrics(driver, tabId);
    scrollX = vp.scrollX;
    scrollY = vp.scrollY;
    innerW = vp.innerWidth;
    innerH = vp.innerHeight;
    x = postDocX - scrollX;
    y = postDocY - scrollY;
    coordSource = "boxmodel-fallback";
  }

  // Off-viewport guard. After scrollIntoView + flush the element should be
  // in view; if it still isn't, surface a clear warning instead of silently
  // dispatching into the void. Uses the resolved viewport (from gBCR when
  // available, else from the separate readViewportMetrics call above) so
  // the guard works in both code paths.
  const offViewport =
    x < 0 ||
    y < 0 ||
    (innerW > 0 && x > innerW) ||
    (innerH > 0 && y > innerH);
  let offViewportNote: string | undefined;
  if (offViewport) {
    offViewportNote =
      `Click point for ${ref} resolved to viewport (${Math.round(x)},${Math.round(y)}) ` +
      `outside the visible viewport ${innerW}x${innerH}. ` +
      `Pre-scroll: doc=(${Math.round(preDocX)},${Math.round(preDocY)}) ` +
      `gBCR=(${Math.round(preGeom.vx)},${Math.round(preGeom.vy)}) ` +
      `scroll=(${preGeom.scrollX},${preGeom.scrollY}). ` +
      `Post-scroll: doc=(${Math.round(postDocX)},${Math.round(postDocY)}) ` +
      `gBCR=(${Math.round(postGeom.vx)},${Math.round(postGeom.vy)}) ` +
      `scroll=(${scrollX},${scrollY}). ` +
      `coordSource=${coordSource}. scrollIntoViewIfNeeded did not land it ` +
      `in view (likely a fixed-position ancestor, transform, or the ` +
      `model's ref is stale — try snapshot then scrollPage before retrying).`;
  }

  // Verbose dispatch log. Includes pre/post snapshots so the next time we
  // see an off-viewport failure we can tell at a glance whether
  // scrollIntoView moved anything (compare pre vs post scroll/gBCR), and
  // whether getBoxModel and gBCR agree (they should after settle).
  // Logged at console.debug — hidden by default, surfaces when DevTools
  // verbose logging is enabled. The forensic value is real but the
  // per-click rate makes console.info too noisy for production.
  console.debug(
    `[click-tool] dispatch ref=${ref} dispatch=(${Math.round(x)},${Math.round(y)}) ` +
      `src=${coordSource} ` +
      `pre={ doc=(${Math.round(preDocX)},${Math.round(preDocY)}) ` +
      `gbcr=(${Math.round(preGeom.vx)},${Math.round(preGeom.vy)})+(${Math.round(preGeom.vw)}x${Math.round(preGeom.vh)}) ` +
      `scroll=(${preGeom.scrollX},${preGeom.scrollY}) ` +
      `vp=${preGeom.innerWidth}x${preGeom.innerHeight} ok=${preGeom.ok} } ` +
      `post={ doc=(${Math.round(postDocX)},${Math.round(postDocY)}) ` +
      `gbcr=(${Math.round(postGeom.vx)},${Math.round(postGeom.vy)})+(${Math.round(postGeom.vw)}x${Math.round(postGeom.vh)}) ` +
      `scroll=(${postGeom.scrollX},${postGeom.scrollY}) ` +
      `vp=${postGeom.innerWidth}x${postGeom.innerHeight} ok=${postGeom.ok} } ` +
      `offViewport=${offViewport} tab=${String(tabId)}` +
      (preGeom.error ? ` preErr="${preGeom.error}"` : "") +
      (postGeom.error ? ` postErr="${postGeom.error}"` : ""),
  );

  // The "agent is working" overlay's input shield (mounted by
  // notifyAgentStatus(true) for ANY agent run, not just CUA) sits at the top
  // of the DOM with pointer-events:auto. CDP `Input.dispatchMouseEvent`
  // produces TRUSTED browser events that respect DOM hit-testing — so without
  // this toggle every main-agent click lands on the shield and the page
  // never sees it. Mirrors cua-loop.ts. Awaited so the shield is provably
  // down before the click and back up after; no-op when no shield is mounted.
  await setShieldPassthrough(driver, tabId, true);
  // Two forensic diagnostics, BOTH inside the passthrough window:
  //   pre-dispatch:  proves whether the shield's `pointer-events:none` toggle
  //                  actually took effect at click time. If shieldPE != "none"
  //                  here, the toggle didn't propagate and the click WILL be
  //                  eaten — even though we asked for passthrough.
  //   post-dispatch: confirms (or refutes) that nothing transient (animation,
  //                  timeout, micro-task) put a different element at the
  //                  click point between our hit-test and the dispatch.
  // Both run inside the passthrough window so the shield is `pointer-events:
  // none` for both reads (when the toggle is working). Earlier we ran ONLY a
  // post-dispatch diagnostic AFTER the passthrough was toggled back off,
  // which produced a guaranteed false-positive `OVERLAY-INTERCEPT` every
  // single click and masked the actual signal.
  let hitWarning: string | undefined;
  try {
    hitWarning = await verifyHitTarget(
      driver,
      tabId,
      x,
      y,
      backendNodeId,
      ref,
    );
    await runClickDiagnostic(driver, tabId, "tool/clickByRef:pre", x, y);
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
    await runClickDiagnostic(driver, tabId, "tool/clickByRef:post", x, y);
  } finally {
    await setShieldPassthrough(driver, tabId, false);
  }

  // Visual feedback: emit the same click ripple the CUA loop fires after a
  // click, so a human watching the live tab sees a transient dot at the
  // dispatch point. Mirrors cua-loop.ts. Fire-and-forget — a ripple must
  // never fail or delay a click.
  void driver
    .sendToContentScript(tabId, { type: "CHAT_CUA_CLICK_RIPPLE", x, y })
    .catch(() => {});

  // Compose the final warning so the off-viewport note (if any) is surfaced
  // alongside the hit-target warning. Off-viewport takes priority because
  // it's a strictly more actionable signal — a hit-target mismatch is moot
  // if the click never landed.
  const warning = offViewportNote
    ? hitWarning
      ? `${offViewportNote} ${hitWarning}`
      : offViewportNote
    : hitWarning;
  return warning ? { warning } : {};
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
  // Logged at debug to mirror clickByRef. NOTE: this path uses the content
  // script's `el.click()` (synthetic JS click), NOT CDP — overlays do not
  // hit-test synthetic clicks, so no post-dispatch [click-diag] is needed
  // here. If a clickBySelector silently fails it's an `el.click()` no-op,
  // not an overlay-interception issue.
  console.debug(
    `[click-tool] dispatch selector="${selector}" tab=${String(tabId)} (synthetic)`,
  );
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

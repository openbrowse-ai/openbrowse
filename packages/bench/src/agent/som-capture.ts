import type { ToolContext } from "@agent/driver";
import { captureSnapshot } from "@agent/snapshot-capture";
import { getRefsForTab } from "@agent/ref-store";

export interface CaptureViewOptions {
  fullPage?: boolean;
}

export interface CapturedView {
  imageDataUrl: string;
  refCount: number;
  url: string;
  legend: string;
  belowFoldCount: number;
  warning?: string;
  /**
   * Viewport accessibility-tree text. Same content the `snapshot` tool returns
   * with `mode: "viewport"`. Populated by `captureSnapshot` and surfaced to
   * the hybrid SoM (`viewPageFull`) variant alongside the annotated image.
   */
  snapshot: string;
}

const COLOR_LEGEND = "buttons=blue, links=green, inputs=orange, other=gray";

function colorForRole(role: string): string {
  if (role === "button") return "rgba(0, 120, 255, 0.85)";
  if (role === "link") return "rgba(40, 180, 80, 0.85)";
  if (
    role === "textbox" ||
    role === "combobox" ||
    role === "searchbox" ||
    role === "spinbutton"
  ) {
    return "rgba(255, 140, 0, 0.85)";
  }
  return "rgba(100, 100, 100, 0.85)";
}

/**
 * Shared implementation for the bench's SoM perception tools.
 *
 *   - Captures a viewport-only a11y snapshot to populate the ref-store and
 *     produce the snapshot text for hybrid SoM.
 *   - Captures a screenshot via CDP `Page.captureScreenshot`.
 *   - Computes per-ref bounding boxes via CDP `DOM.getBoxModel`.
 *   - Injects a canvas overlay into the page and draws labelled boxes.
 *   - Re-captures the screenshot to include the labels.
 *   - Cleans up the canvas.
 *
 * The viewportOnly snapshot mode is critical: without it the ref-store
 * contains every interactive element on the page (often 100+ refs) but only
 * the viewport-visible ones get drawn, leading the model to hallucinate refs
 * for elements it cannot see.
 *
 * Both `viewPageTool` and `viewPageFullTool` call this helper. The "full"
 * (hybrid) variant additionally surfaces the viewport a11y tree text via the
 * `snapshot` field — `@ref` IDs in the text and on the image are guaranteed
 * consistent because they come from the same captureSnapshot call.
 */
export async function captureViewPage(
  ctx: ToolContext,
  opts: CaptureViewOptions,
): Promise<CapturedView> {
  const tab = await ctx.driver.getActiveTab();
  const tabId = tab.id;
  const fullPage = opts.fullPage ?? false;

  const { refs, belowFoldCount, snapshotText } = await captureSnapshot(
    ctx.driver,
    tabId,
    {
      mode: "interactive",
      viewportOnly: true,
    },
  );

  const captureParams: Record<string, unknown> = { format: "png" };
  if (fullPage) {
    captureParams.captureBeyondViewport = true;
    const metrics = await ctx.driver.sendCommand<{
      contentSize: { width: number; height: number };
    }>(tabId, "Page.getLayoutMetrics");
    captureParams.clip = {
      x: 0,
      y: 0,
      width: metrics.contentSize.width,
      height: metrics.contentSize.height,
      scale: 1,
    };
  }

  // Capture (with one retry) — Chrome occasionally returns -32000 mid-paint.
  let screenshotResult: { data: string };
  try {
    screenshotResult = await ctx.driver.sendCommand<{ data: string }>(
      tabId,
      "Page.captureScreenshot",
      captureParams,
    );
  } catch (firstErr) {
    await new Promise((r) => setTimeout(r, 600));
    try {
      screenshotResult = await ctx.driver.sendCommand<{ data: string }>(
        tabId,
        "Page.captureScreenshot",
        captureParams,
      );
    } catch (secondErr) {
      throw new Error(
        `Page.captureScreenshot failed twice — ${
          secondErr instanceof Error ? secondErr.message : String(secondErr)
        }`,
      );
    }
  }

  let imageData = screenshotResult.data;
  let warning: string | undefined;

  // Annotate by:
  //   1. Asking Chrome for each ref's bounding box (via CDP)
  //   2. Injecting a canvas overlay into the page
  //   3. Drawing every box + label at the document-coordinate position
  //   4. Re-capturing
  //   5. Removing the canvas
  try {
    const activeRefs = getRefsForTab(tabId);
    if (activeRefs && activeRefs.size > 0) {
      const boxes: Array<{
        ref: string;
        role: string;
        x: number;
        y: number;
        w: number;
        h: number;
        color: string;
      }> = [];

      const entries = Array.from(activeRefs.entries());
      const BATCH = 16;
      for (let i = 0; i < entries.length; i += BATCH) {
        const slice = entries.slice(i, i + BATCH);
        const results = await Promise.all(
          slice.map(async ([ref, entry]) => {
            try {
              const box = await ctx.driver.sendCommand<{
                model?: { content: number[] };
              }>(tabId, "DOM.getBoxModel", {
                backendNodeId: entry.backendNodeId,
              });
              if (!box.model?.content) return null;
              const pts = box.model.content;
              const xs = [pts[0], pts[2], pts[4], pts[6]];
              const ys = [pts[1], pts[3], pts[5], pts[7]];
              return {
                ref,
                role: entry.role,
                x: Math.min(...xs),
                y: Math.min(...ys),
                w: Math.max(...xs) - Math.min(...xs),
                h: Math.max(...ys) - Math.min(...ys),
                color: colorForRole(entry.role),
              };
            } catch {
              return null;
            }
          }),
        );
        for (const r of results) if (r) boxes.push(r);
      }

      // Inject and draw. Font size bumped 12 → 14, bold weight, 1px white
      // text stroke for readability against any background, slightly
      // thicker box outline. These changes substantially improve the
      // model's ability to read ref labels off the screenshot.
      const injectScript = `
        (async () => {
          const boxes = ${JSON.stringify(boxes)};
          const canvas = document.createElement('canvas');
          canvas.id = 'openbrowse-som-overlay';
          canvas.style.position = 'absolute';
          canvas.style.top = '0';
          canvas.style.left = '0';
          canvas.style.pointerEvents = 'none';
          canvas.style.zIndex = '2147483647';
          canvas.width = Math.max(document.documentElement.scrollWidth, window.innerWidth);
          canvas.height = Math.max(document.documentElement.scrollHeight, window.innerHeight);
          document.body.appendChild(canvas);

          const ctx = canvas.getContext('2d');
          ctx.font = 'bold 14px system-ui, -apple-system, sans-serif';
          ctx.textBaseline = 'top';

          let drawn = 0;
          for (const b of boxes) {
            if (b.w === 0 || b.h === 0) continue;

            ctx.strokeStyle = b.color;
            ctx.lineWidth = 2.5;
            ctx.strokeRect(b.x, b.y, b.w, b.h);

            const text = b.ref;
            const padX = 6;
            const badgeH = 20;
            const metrics = ctx.measureText(text);
            const badgeW = metrics.width + padX * 2;

            // Badge background — the role color, fully opaque for label area
            ctx.fillStyle = b.color;
            ctx.fillRect(b.x, b.y, badgeW, badgeH);

            // White outer stroke around the text for contrast
            ctx.strokeStyle = 'white';
            ctx.lineWidth = 3;
            ctx.lineJoin = 'round';
            ctx.strokeText(text, b.x + padX, b.y + 3);

            // White text fill
            ctx.fillStyle = 'white';
            ctx.fillText(text, b.x + padX, b.y + 3);

            drawn++;
          }
          return drawn;
        })()
      `;

      const injectRes = await ctx.driver.sendCommand<{
        result?: { value?: number };
      }>(tabId, "Runtime.evaluate", {
        expression: injectScript,
        awaitPromise: true,
        returnByValue: true,
      });

      const boxesDrawn = injectRes.result?.value ?? 0;

      if (boxesDrawn > 0) {
        const annotatedRes = await ctx.driver.sendCommand<{ data: string }>(
          tabId,
          "Page.captureScreenshot",
          captureParams,
        );
        imageData = annotatedRes.data;

        await ctx.driver.sendCommand(tabId, "Runtime.evaluate", {
          expression: `document.getElementById('openbrowse-som-overlay')?.remove()`,
        });
      }
    }
  } catch (err) {
    warning = `Annotation failed: ${
      err instanceof Error ? err.message : String(err)
    }`;
  }

  return {
    imageDataUrl: `data:image/png;base64,${imageData}`,
    refCount: refs.size,
    url: tab.url ?? "",
    legend: COLOR_LEGEND,
    belowFoldCount,
    warning,
    snapshot: snapshotText,
  };
}

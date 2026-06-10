import { z } from "zod";
import type { BrowserDriver, TabId } from "../driver";
import { resolveTabOrThrow } from "../driver";
import { getRefsForTab, type RefEntry } from "../ref-store";
import { captureScreenshot } from "../capture-utils";
import type { BrowserTool } from "../types";

const parameters = z.object({
  tab: z
    .string()
    .describe(
      "Tab handle to capture (e.g. 't1'). See the `## Tabs in this conversation` section of the system prompt, or call listTabs.",
    ),
  annotate: z
    .boolean()
    .optional()
    .describe(
      "Overlay @ref labels on interactive elements, color-coded by role (buttons blue, links green, inputs orange, other gray). Requires a prior snapshot so ref→element bounds are known.",
    ),
  fullPage: z
    .boolean()
    .optional()
    .describe("Capture full scrollable page, not just the viewport"),
});

type Input = z.infer<typeof parameters>;

const outputSchema = z.object({
  tab: z.string(),
  imageDataUrl: z.string().optional(),
  annotatedCount: z.number().optional(),
  annotationError: z.string().optional(),
  note: z.string().optional(),
});
type Output = z.infer<typeof outputSchema>;

export const screenshotTool: BrowserTool<Input, Output> = {
  name: "screenshot",
  description:
    "Capture a screenshot of a tab. Pass `tab` (handle from the tab legend or listTabs). Works even if the tab is not focused. Use annotate: true to overlay @ref labels from the most recent snapshot — useful when the page has visual complexity the accessibility tree doesn't capture well. The response includes annotatedCount when annotation succeeded; if annotation was requested but failed, an annotationError field explains why.",
  parameters,
  outputSchema,
  execute: async ({ tab: handle, annotate, fullPage }, ctx) => {
    const tab = await resolveTabOrThrow(ctx, handle);
    const tabId = tab.id;

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

    // Capture via the shared helper, which hides OpenBrowse's own overlays
    // (the "working" glow/pill, ripple, toasts, SoM overlay) so they never
    // leak into the model-facing image, and retries once on the transient
    // `-32000 Unable to capture screenshot` error. Annotation (below) draws
    // on the already-clean image, so annotated screenshots are overlay-free
    // too.
    let imageData: string;
    try {
      imageData = await captureScreenshot(ctx.driver, tabId, captureParams);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Page.captureScreenshot failed twice — ${msg}. Tab may be discarded or in a transient state; try scrolling or waiting before retrying.`,
      );
    }

    let annotatedCount: number | undefined;
    let annotationError: string | undefined;

    if (annotate) {
      try {
        const annotated = await annotateScreenshot(
          ctx.driver,
          tabId,
          imageData,
          fullPage ?? false,
        );
        imageData = annotated.imageData;
        annotatedCount = annotated.boxesDrawn;
        if (annotated.warning) {
          annotationError = annotated.warning;
        }
      } catch (err) {
        annotationError =
          err instanceof Error ? err.message : String(err);
      }
    }

    const out: Output = {
      tab: handle,
      imageDataUrl: `data:image/png;base64,${imageData}`,
    };
    if (annotatedCount != null) out.annotatedCount = annotatedCount;
    if (annotationError) out.annotationError = annotationError;
    return out;
  },
};

// ============================================================================
// Annotation implementation
// ============================================================================

interface BoxRect {
  ref: string;
  role: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Color palette for label badges, keyed by accessibility role. Matches
 * rough convention from browser devtools and SoM papers:
 *  - blue for buttons / actions
 *  - green for links / navigation
 *  - orange for text inputs
 *  - gray for everything else
 */
function colorForRole(role: string): { fill: string; stroke: string } {
  if (role === "button" || role === "tab" || role === "menuitem") {
    return { fill: "#3b82f6", stroke: "#1e40af" };
  }
  if (role === "link") {
    return { fill: "#10b981", stroke: "#047857" };
  }
  if (
    role === "textbox" ||
    role === "searchbox" ||
    role === "combobox" ||
    role === "spinbutton"
  ) {
    return { fill: "#f59e0b", stroke: "#b45309" };
  }
  return { fill: "#6b7280", stroke: "#374151" };
}

interface AnnotateResult {
  imageData: string;
  boxesDrawn: number;
  /** Set when annotation completed but with degraded results (e.g. some refs failed). */
  warning?: string;
}

async function annotateScreenshot(
  driver: BrowserDriver,
  tabId: TabId,
  base64Png: string,
  fullPage: boolean,
): Promise<AnnotateResult> {
  const refs = getRefsForTab(tabId);
  if (!refs || refs.size === 0) {
    throw new Error(
      "annotate: no refs available for this tab. Call snapshot before screenshot to populate the ref map. Note that scoped snapshots (with selector) may have fewer refs than full snapshots.",
    );
  }

  // Get scroll offset AND device pixel ratio. CDP `Page.captureScreenshot`
  // returns the image at native (DPR-scaled) resolution, but `DOM.getBoxModel`
  // returns CSS-pixel coordinates. Without DPR scaling, labels on HiDPI
  // displays end up at half the correct position (compressed into the
  // upper-left quadrant of the image).
  let scrollX = 0;
  let scrollY = 0;
  let dpr = 1;
  try {
    const ctx = await driver.sendCommand<{
      result?: { value?: { sx: number; sy: number; dpr: number } };
    }>(tabId, "Runtime.evaluate", {
      expression: `({ sx: window.scrollX, sy: window.scrollY, dpr: window.devicePixelRatio || 1 })`,
      returnByValue: true,
    });
    if (ctx.result?.value) {
      if (!fullPage) {
        scrollX = ctx.result.value.sx;
        scrollY = ctx.result.value.sy;
      }
      dpr = ctx.result.value.dpr || 1;
    }
  } catch {
    // fall through with defaults
  }

  const boxes: BoxRect[] = [];
  const entries: [string, RefEntry][] = Array.from(refs);

  // Parallelize getBoxModel calls with a bounded concurrency. Chrome's CDP
  // handles this fine; we cap to avoid overwhelming the debugger.
  const BATCH = 16;
  for (let i = 0; i < entries.length; i += BATCH) {
    const slice = entries.slice(i, i + BATCH);
    const results = await Promise.all(
      slice.map(async ([ref, entry]) => {
        try {
          const box = await driver.sendCommand<{ model?: { content: number[] } }>(
            tabId,
            "DOM.getBoxModel",
            { backendNodeId: entry.backendNodeId },
          );
          if (!box.model?.content) return null;
          const pts = box.model.content;
          // content quad: [x0,y0, x1,y1, x2,y2, x3,y3] (top-left, top-right,
          // bottom-right, bottom-left). Compute axis-aligned bounds in CSS
          // pixels, then scale to image-pixel space by multiplying by DPR.
          const xs = [pts[0], pts[2], pts[4], pts[6]];
          const ys = [pts[1], pts[3], pts[5], pts[7]];
          const minX = (Math.min(...xs) - scrollX) * dpr;
          const minY = (Math.min(...ys) - scrollY) * dpr;
          const maxX = (Math.max(...xs) - scrollX) * dpr;
          const maxY = (Math.max(...ys) - scrollY) * dpr;
          return {
            ref,
            role: entry.role,
            x: minX,
            y: minY,
            w: maxX - minX,
            h: maxY - minY,
          } as BoxRect;
        } catch {
          return null;
        }
      }),
    );
    for (const r of results) {
      if (r) boxes.push(r);
    }
  }

  if (boxes.length === 0) {
    throw new Error(
      `annotate: had ${refs.size} refs but DOM.getBoxModel returned no usable bounds. The page may have changed since the last snapshot — try snapshot then screenshot in quick succession.`,
    );
  }

  const blob = base64ToBlob(base64Png);
  const bitmap = await createImageBitmap(blob);
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(bitmap, 0, 0);

  // Scale UI dimensions by DPR so labels stay readable at the same physical
  // size regardless of display density. Without this, on a 2x display the
  // 11px font would render as 5.5 visual px and be unreadable.
  const fontSize = 11 * dpr;
  const badgeH = 16 * dpr;
  const badgePad = 4 * dpr;
  const badgeMargin = 2 * dpr;
  const strokeWidth = 1.5 * dpr;
  const cornerRadius = 3 * dpr;
  const minBoxSize = 20 * dpr;

  ctx.font = `bold ${fontSize}px system-ui, sans-serif`;
  ctx.textBaseline = "middle";

  // Track occupied label rects for simple collision avoidance.
  const occupied: Array<{ x: number; y: number; w: number; h: number }> = [];

  // Sort by y then x so we draw top-down, left-to-right — collisions resolve
  // by pushing later labels down.
  boxes.sort((a, b) => a.y - b.y || a.x - b.x);

  let drawn = 0;
  let skippedTooSmall = 0;
  let skippedOffscreen = 0;

  for (const box of boxes) {
    // Skip tiny elements — a label would obscure them entirely.
    if (box.w < minBoxSize || box.h < minBoxSize) {
      skippedTooSmall++;
      continue;
    }
    if (box.x + box.w < 0 || box.y + box.h < 0) {
      skippedOffscreen++;
      continue;
    }
    if (box.x > canvas.width || box.y > canvas.height) {
      skippedOffscreen++;
      continue;
    }

    const colors = colorForRole(box.role);

    // Outline rectangle around the element so the agent can see element bounds.
    ctx.strokeStyle = colors.stroke;
    ctx.lineWidth = strokeWidth;
    ctx.strokeRect(box.x, box.y, box.w, box.h);

    // Badge positioning: top-left corner of the element, shifted inside by 2px.
    const label = box.ref;
    const textWidth = ctx.measureText(label).width;
    const badgeW = Math.min(textWidth + badgePad * 2, box.w);
    let bx = box.x + badgeMargin;
    let by = box.y + badgeMargin;

    // Collision avoidance: if this badge overlaps an already-placed one,
    // shift it down by badgeH + margin until it fits (or gives up after 5 tries).
    for (let tries = 0; tries < 5; tries++) {
      const collision = occupied.some(
        (o) =>
          bx < o.x + o.w && bx + badgeW > o.x && by < o.y + o.h && by + badgeH > o.y,
      );
      if (!collision) break;
      by += badgeH + badgeMargin;
      if (by > box.y + box.h - badgeH) break;
    }

    ctx.fillStyle = colors.fill;
    if (typeof (ctx as unknown as { roundRect?: unknown }).roundRect === "function") {
      ctx.beginPath();
      (ctx as unknown as {
        roundRect: (
          x: number,
          y: number,
          w: number,
          h: number,
          r: number,
        ) => void;
      }).roundRect(bx, by, badgeW, badgeH, cornerRadius);
      ctx.fill();
    } else {
      ctx.fillRect(bx, by, badgeW, badgeH);
    }

    ctx.fillStyle = "#fff";
    ctx.fillText(label, bx + badgePad, by + badgeH / 2);

    occupied.push({ x: bx, y: by, w: badgeW, h: badgeH });
    drawn++;
  }

  const outBlob = await canvas.convertToBlob({ type: "image/png" });
  const buffer = await outBlob.arrayBuffer();
  const imageData = bufferToBase64(buffer);

  let warning: string | undefined;
  if (drawn === 0) {
    warning = `Annotation produced no labels: ${skippedTooSmall} elements too small, ${skippedOffscreen} off-viewport. The viewport may not contain the elements you expected — try scrolling to the relevant area first.`;
  } else if (drawn < boxes.length / 4 && skippedOffscreen > drawn) {
    warning = `Only ${drawn} of ${boxes.length} refs are in the current viewport (${skippedOffscreen} off-screen). Most of the snapshot's elements aren't visible — scroll to the area you care about and re-screenshot.`;
  }

  return { imageData, boxesDrawn: drawn, warning };
}

function base64ToBlob(base64: string): Blob {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: "image/png" });
}

function bufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

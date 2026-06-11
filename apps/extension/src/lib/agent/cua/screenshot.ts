/**
 * CUA screenshot capture + normalization.
 *
 * CRITICAL for click accuracy: CDP `Page.captureScreenshot` returns the image
 * at NATIVE (device-pixel) resolution — on a HiDPI/Retina display that's
 * `cssWidth * devicePixelRatio` wide. But we declare the display to the model
 * as CSS pixels (`displayWidthPx`/`displayHeightPx`), and the model returns
 * coordinates in that declared space. If the image we send is 2× larger than
 * the declared size, the model's visual grounding and our coordinate space
 * disagree and clicks land in the wrong place.
 *
 * Anthropic's own reference implementation resizes the screenshot to exactly
 * the declared display dimensions (`convert -resize WxH!`). We do the same
 * here using an OffscreenCanvas so image-pixels == declared-pixels == the
 * model's coordinate space.
 */

import type { BrowserDriver, TabId } from "../driver";
import { captureViewportShot } from "./executor";

/**
 * Capture the viewport and resize the PNG to exactly `targetWidth` ×
 * `targetHeight` (the dimensions declared to the model). Returns a
 * `data:image/png;base64,...` URL. Falls back to the raw capture if canvas
 * resizing is unavailable (e.g. a non-DOM test environment).
 */
export async function captureNormalizedShot(
  driver: BrowserDriver,
  tabId: TabId,
  targetWidth: number,
  targetHeight: number,
): Promise<string> {
  const base64 = await captureViewportShot(driver, tabId);
  const dataUrl = `data:image/png;base64,${base64}`;

  // Resize only when the canvas primitives exist. The annotator
  // (tools/screenshot.ts) relies on the same OffscreenCanvas/createImageBitmap
  // APIs in the service worker, so this is available in production.
  const hasCanvas =
    typeof OffscreenCanvas !== "undefined" &&
    typeof createImageBitmap !== "undefined";
  if (!hasCanvas) return dataUrl;

  try {
    const blob = base64ToPngBlob(base64);
    const bitmap = await createImageBitmap(blob);
    // Already the right size (no DPR scaling and within max) — skip re-encode.
    if (bitmap.width === targetWidth && bitmap.height === targetHeight) {
      bitmap.close();
      return dataUrl;
    }
    const canvas = new OffscreenCanvas(targetWidth, targetHeight);
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      bitmap.close();
      return dataUrl;
    }
    ctx.drawImage(bitmap, 0, 0, targetWidth, targetHeight);
    bitmap.close();
    const outBlob = await canvas.convertToBlob({ type: "image/png" });
    const buffer = await outBlob.arrayBuffer();
    return `data:image/png;base64,${bufferToBase64(buffer)}`;
  } catch {
    // Any decode/encode failure: fall back to the raw capture rather than
    // failing the whole action.
    return dataUrl;
  }
}

function base64ToPngBlob(base64: string): Blob {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: "image/png" });
}

function bufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/**
 * Capture the viewport and crop to a region given in DECLARED display coords
 * (the space the model declared via display_width/height_px). The native
 * capture is larger on HiDPI, so we scale the region by (nativeWidth /
 * displayWidth). Returns a `data:image/png;base64,...` crop at native
 * resolution so the model can read small text. Falls back to the full
 * normalized shot when canvas primitives are unavailable (tests).
 */
export async function captureRegionShot(
  driver: BrowserDriver,
  tabId: TabId,
  region: { x1: number; y1: number; x2: number; y2: number },
  displayWidth: number,
  displayHeight: number,
): Promise<string> {
  const hasCanvas =
    typeof OffscreenCanvas !== "undefined" && typeof createImageBitmap !== "undefined";
  if (!hasCanvas) return captureNormalizedShot(driver, tabId, displayWidth, displayHeight);

  const base64 = await captureViewportShot(driver, tabId);
  const blob = await (await fetch(`data:image/png;base64,${base64}`)).blob();
  const bmp = await createImageBitmap(blob);
  const scale = bmp.width / displayWidth;
  const sx = Math.max(0, Math.round(region.x1 * scale));
  const sy = Math.max(0, Math.round(region.y1 * scale));
  const sw = Math.max(1, Math.round((region.x2 - region.x1) * scale));
  const sh = Math.max(1, Math.round((region.y2 - region.y1) * scale));
  const canvas = new OffscreenCanvas(sw, sh);
  const ctx = canvas.getContext("2d");
  if (!ctx) return captureNormalizedShot(driver, tabId, displayWidth, displayHeight);
  ctx.drawImage(bmp, sx, sy, sw, sh, 0, 0, sw, sh);
  const outBlob = await canvas.convertToBlob({ type: "image/png" });
  const buf = await outBlob.arrayBuffer();
  // Use the loop-based encoder (not `String.fromCharCode(...spread)`), which
  // overflows the call stack for large screenshots.
  const b64 = bufferToBase64(buf);
  return `data:image/png;base64,${b64}`;
}

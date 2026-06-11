import type { BrowserDriver, TabId } from "../driver";

export interface CssViewport {
  cssWidth: number;
  cssHeight: number;
  devicePixelRatio: number;
}

export interface Display {
  /** Width declared to the model (CSS px, possibly downscaled). */
  displayWidth: number;
  displayHeight: number;
  /** displayWidth / cssWidth. 1 when no downscale was needed. */
  downscale: number;
}

/**
 * Read the tab's live CSS viewport + DPR. We do NOT override the viewport
 * (Emulation.setDeviceMetricsOverride) because CUA runs on the parent's
 * live tab and reflowing it would change what the parent sees.
 */
export async function readViewport(
  driver: BrowserDriver,
  tabId: TabId,
): Promise<CssViewport> {
  const result = await driver.sendCommand<{
    result: { value: { w: number; h: number; dpr: number } };
  }>(tabId, "Runtime.evaluate", {
    expression:
      "({w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio})",
    returnByValue: true,
  });
  const { w, h, dpr } = result.result.value;
  return { cssWidth: w, cssHeight: h, devicePixelRatio: dpr || 1 };
}

/**
 * Decide the display size declared to the model. Downscale only the WIDTH
 * proportionally when it exceeds the provider's recommended max.
 */
export function computeDisplay(opts: {
  cssWidth: number;
  cssHeight: number;
  maxWidth: number;
}): Display {
  const { cssWidth, cssHeight, maxWidth } = opts;
  if (cssWidth <= maxWidth) {
    return { displayWidth: cssWidth, displayHeight: cssHeight, downscale: 1 };
  }
  const downscale = maxWidth / cssWidth;
  return {
    displayWidth: maxWidth,
    displayHeight: Math.round(cssHeight * downscale),
    downscale,
  };
}

/**
 * Anthropic returns pixels in the declared (possibly downscaled) display.
 * Recover CSS pixels by dividing out the downscale factor.
 */
export function mapAnthropicCoord(
  modelX: number,
  modelY: number,
  downscale: number,
): { x: number; y: number } {
  return {
    x: Math.round(modelX / downscale),
    y: Math.round(modelY / downscale),
  };
}

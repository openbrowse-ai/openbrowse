import { captureScreenshot } from "@/lib/agent/capture-utils";

/**
 * `screenshot` RPC handler.
 *
 * Captures a PNG screenshot of the target tab via the shared
 * `captureScreenshot` helper (which hides OpenBrowse overlays around the
 * capture and retries on transient `-32000` errors). Returns the bytes as a
 * base64 string under a recognizable `{contentType, filename, base64}`
 * shape — the broker side detects this shape, stores the bytes in the
 * artifact store, and rewrites the MCP host-facing result to an
 * `artifactUrl` reference. The extension itself never sees an artifact
 * URL; that's a broker concern.
 */

class RpcError extends Error {
  constructor(message: string, public readonly code: string) {
    super(message);
  }
}

export interface ScreenshotParams {
  tabId?: number;
  /** Capture beyond the viewport (full-page). Defaults to false. */
  fullPage?: boolean;
}

export interface ScreenshotResult {
  contentType: "image/png";
  filename: string;
  /** Raw base64 PNG bytes (no `data:` prefix). */
  base64: string;
}

async function resolveTabId(params: ScreenshotParams): Promise<number> {
  if (typeof params.tabId === "number") {
    try {
      await chrome.tabs.get(params.tabId);
      return params.tabId;
    } catch {
      throw new RpcError("tab not found", "tab_not_found");
    }
  }
  const win = await chrome.windows.getCurrent();
  if (!win.id) throw new RpcError("no focused window", "no_focused_window");
  const tabs = await chrome.tabs.query({ windowId: win.id, active: true });
  const t = tabs[0];
  if (!t?.id) throw new RpcError("no active tab in focused window", "tab_not_found");
  return t.id;
}

export async function handleScreenshot(
  rawParams: unknown,
  _ctx: import("../index").RpcHandlerContext,
): Promise<ScreenshotResult> {
  const params = (rawParams ?? {}) as ScreenshotParams;
  const tabId = await resolveTabId(params);

  // Same pattern as read-page: instantiate a fresh ExtensionDriver — it's
  // stateless apart from per-call CDP attach state.
  const { ExtensionDriver } = await import("@/lib/agent/driver/extension-driver");
  const driver = new ExtensionDriver();

  // `captureScreenshot`'s 3rd arg is forwarded to `Page.captureScreenshot`.
  // For full-page, set `captureBeyondViewport: true` — the off-screen
  // renderer path that the helper's retry strategy already understands.
  const cdpParams: Record<string, unknown> = { format: "png" };
  if (params.fullPage) cdpParams.captureBeyondViewport = true;

  const base64 = await captureScreenshot(driver, tabId, cdpParams);
  if (typeof base64 !== "string" || base64.length === 0) {
    throw new RpcError("screenshot capture failed", "internal_error");
  }

  return {
    contentType: "image/png",
    filename: `screenshot-${tabId}-${Date.now()}.png`,
    base64,
  };
}

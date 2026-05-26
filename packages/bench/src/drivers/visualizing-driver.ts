/**
 * `BrowserDriver` decorator that injects visual click rings and typing
 * tooltips into the page so the recorded video shows where the agent
 * clicked and what it typed.
 *
 * Pattern: composition. Wraps an inner `BrowserDriver` (production:
 * `PlaywrightDriver`; theoretically anything implementing the interface)
 * and intercepts CDP commands that signal user-input events. Every other
 * method is forwarded as-is.
 *
 * Why this lives in the bench harness rather than the agent core:
 *  - It's a debug/eval feature; production users don't need overlays
 *    (the extension already shows its own indicator UI).
 *  - It's additive — wrap or don't wrap, no impact on the agent loop.
 *  - Future move: if we want production extension users to also see
 *    overlays, we can lift this class into `agent-core` and have the
 *    extension wrap its `ExtensionDriver` the same way.
 *
 * Properties of the injected overlays:
 *  - `position: fixed`, `pointer-events: none` → zero interference with
 *    any click/keystroke the agent is issuing
 *  - `z-index: 2147483647` → above everything except other near-max nodes
 *  - Appended to `documentElement` not `body` → survives some SPA rerenders
 *  - Auto-removed via `setTimeout` so a navigation-triggering click
 *    doesn't leave artifacts on the destination page
 *  - Keyframes injected once per page (idempotent via a marker attribute)
 */

import type {
  BrowserDriver,
  BrowserTabInfo,
  TabId,
} from "@agent/driver";

const STYLE_MARKER = "data-openbrowse-vis-installed";
const TOAST_MARKER = "data-openbrowse-tool-toast";
const CSS = `
@keyframes openbrowse-click-ring {
  0%   { transform: scale(0.6); opacity: 1; }
  100% { transform: scale(1.6); opacity: 0; }
}
@keyframes openbrowse-tool-toast {
  0%   { transform: translate(-50%, 24px); opacity: 0; }
  10%  { transform: translate(-50%, 0);    opacity: 1; }
  90%  { transform: translate(-50%, 0);    opacity: 1; }
  100% { transform: translate(-50%, 24px); opacity: 0; }
}
`.trim();

/**
 * JS injected as the body of a Runtime.evaluate call. Receives the click
 * coordinates (or typed text) via interpolation. Self-contained; no
 * dependency on document state beyond the marker check.
 */
function buildClickRingScript(x: number, y: number): string {
  return `(() => {
    if (!document.documentElement.hasAttribute(${JSON.stringify(STYLE_MARKER)})) {
      const s = document.createElement('style');
      s.textContent = ${JSON.stringify(CSS)};
      document.documentElement.appendChild(s);
      document.documentElement.setAttribute(${JSON.stringify(STYLE_MARKER)}, '');
    }
    const r = document.createElement('div');
    const size = 40;
    r.style.cssText = [
      'position: fixed',
      'left: ' + (${x} - size/2) + 'px',
      'top: '  + (${y} - size/2) + 'px',
      'width: ' + size + 'px',
      'height: ' + size + 'px',
      'border-radius: 50%',
      'border: 3px solid rgba(59, 130, 246, 0.9)',
      'box-shadow: 0 0 12px rgba(59, 130, 246, 0.6)',
      'pointer-events: none',
      'z-index: 2147483647',
      'animation: openbrowse-click-ring 800ms ease-out forwards',
    ].join('; ');
    document.documentElement.appendChild(r);
    setTimeout(() => r.remove(), 1000);
  })()`;
}

export function buildToolToastScript(toolName: string, input: unknown): string {
  let displayInput = "";
  try {
    const json = JSON.stringify(input);
    if (json && json !== "{}") {
      displayInput = json;
    }
  } catch {
    displayInput = String(input);
  }

  const text = displayInput ? `${toolName}(${displayInput})` : `${toolName}()`;
  const display = text.length > 120 ? text.slice(0, 117) + "..." : text;

  return `(() => {
    if (!document.documentElement.hasAttribute(${JSON.stringify(STYLE_MARKER)})) {
      const s = document.createElement('style');
      s.textContent = ${JSON.stringify(CSS)};
      document.documentElement.appendChild(s);
      document.documentElement.setAttribute(${JSON.stringify(STYLE_MARKER)}, '');
    }
    document.querySelectorAll('[' + ${JSON.stringify(TOAST_MARKER)} + ']').forEach((el) => el.remove());
    const tip = document.createElement('div');
    tip.setAttribute(${JSON.stringify(TOAST_MARKER)}, '');
    tip.textContent = '\u2699\uFE0F ' + ${JSON.stringify(display)};
    tip.style.cssText = [
      'position: fixed',
      'bottom: 32px',
      'left: 50%',
      'max-width: 80vw',
      'padding: 10px 18px',
      'background: rgba(17, 24, 39, 0.95)',
      'color: #fff',
      'border-radius: 999px',
      'font: 14px/1.3 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
      'font-weight: 500',
      'letter-spacing: 0.01em',
      'white-space: nowrap',
      'overflow: hidden',
      'text-overflow: ellipsis',
      'pointer-events: none',
      'z-index: 2147483647',
      'box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35), 0 0 0 1px rgba(255, 255, 255, 0.05) inset',
      'animation: openbrowse-tool-toast 3000ms ease-out forwards',
    ].join('; ');
    document.documentElement.appendChild(tip);
    setTimeout(() => tip.remove(), 3200);
  })()`;
}

export interface VisualizingDriverOptions {
  /** When false, the driver acts as a transparent passthrough. */
  enabled?: boolean;
}

export class VisualizingDriver implements BrowserDriver {
  private inner: BrowserDriver;
  private enabled: boolean;

  constructor(inner: BrowserDriver, opts: VisualizingDriverOptions = {}) {
    this.inner = inner;
    this.enabled = opts.enabled ?? true;
  }

  async sendCommand<T = unknown>(
    tabId: TabId,
    method: string,
    params?: Record<string, unknown>,
  ): Promise<T> {
    // Forward the original CDP call first — overlays must not delay or
    // alter the actual user-input event seen by the page.
    const result = await this.inner.sendCommand<T>(tabId, method, params);

    if (!this.enabled) return result;

    try {
      // Click ring on mousePressed. We deliberately ignore mouseMoved
      // (would flood the page) and mouseReleased (covered by the press).
      if (
        method === "Input.dispatchMouseEvent" &&
        params &&
        (params as { type?: string }).type === "mousePressed" &&
        typeof (params as { x?: number }).x === "number" &&
        typeof (params as { y?: number }).y === "number"
      ) {
        const x = (params as { x: number }).x;
        const y = (params as { y: number }).y;
        await this.inner
          .sendCommand(tabId, "Runtime.evaluate", {
            expression: buildClickRingScript(x, y),
            returnByValue: true,
            awaitPromise: false,
          })
          .catch(() => {
            // Page may have navigated mid-flight; the click still landed.
          });
      }
    } catch {
      // Overlay injection is best-effort — never let it surface as a tool
      // error to the agent.
    }

    return result;
  }

  // -------------------------------------------------------------------------
  // Pure passthrough for everything that doesn't need decoration.
  // -------------------------------------------------------------------------

  getActiveTab(): Promise<BrowserTabInfo> {
    return this.inner.getActiveTab();
  }

  getTab(tabId: TabId): Promise<BrowserTabInfo> {
    return this.inner.getTab(tabId);
  }

  setActiveTab(tabId: TabId | null): Promise<void> {
    return this.inner.setActiveTab(tabId);
  }

  getActiveTabId(): TabId | null {
    return this.inner.getActiveTabId();
  }

  listTabs(): Promise<BrowserTabInfo[]> {
    return this.inner.listTabs();
  }

  updateTabUrl(tabId: TabId, url: string): Promise<void> {
    return this.inner.updateTabUrl(tabId, url);
  }

  createTab(url: string, opts?: { active?: boolean }): Promise<TabId> {
    return this.inner.createTab(url, opts);
  }

  waitForLoad(tabId: TabId, timeoutMs?: number): Promise<void> {
    return this.inner.waitForLoad(tabId, timeoutMs);
  }

  closeTab(tabId: TabId): Promise<void> {
    return this.inner.closeTab(tabId);
  }

  sendToContentScript<T = unknown>(
    tabId: TabId,
    message: Record<string, unknown>,
  ): Promise<T> {
    return this.inner.sendToContentScript<T>(tabId, message);
  }
}

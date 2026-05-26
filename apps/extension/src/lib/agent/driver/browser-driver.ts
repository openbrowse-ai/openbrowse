/**
 * Abstraction over the browser environment the agent operates in.
 *
 * Two concrete implementations:
 *
 *   - `ExtensionDriver` (production): wraps `chrome.debugger`, `chrome.tabs`,
 *     and `chrome.scripting` so the existing extension behavior is preserved.
 *   - `PlaywrightDriver` (benchmarking): wraps a Playwright `Page` plus a
 *     Playwright-native CDP session so the agent can run headlessly in
 *     Node.js without loading the extension at all.
 *
 * The driver intentionally exposes the same low-level CDP surface the agent
 * already speaks (e.g. `Accessibility.getFullAXTree`, `Input.dispatchMouseEvent`)
 * because that is the contract the snapshot/click/screenshot pipeline depends
 * on. Higher-level abstractions are deliberately avoided so that the snapshot
 * capture logic in `snapshot-capture.ts` can stay verbatim.
 *
 * Tab ids are typed as opaque `TabId` (number in the extension, string in
 * Playwright) so callers don't accidentally arithmetic-on or compare them.
 */

export type TabId = number | string;

export interface BrowserTabInfo {
  id: TabId;
  url: string;
  title: string;
  /** True when this is the user-visible active tab (extension only). */
  active?: boolean;
  /** Optional favicon URL (extension only; Playwright sets to undefined). */
  favIconUrl?: string;
  /** True when the tab is pinned by the user (extension only). */
  pinned?: boolean;
}

export interface BrowserDriver {
  /**
   * Send a raw Chrome DevTools Protocol command to a specific tab.
   *
   * This is the single most important method on the driver — the snapshot,
   * click, screenshot, scroll, and read-page tools all funnel through it.
   * Implementations must enable the relevant CDP domain on demand and handle
   * detach-on-navigation by reattaching transparently.
   */
  sendCommand<T = unknown>(
    tabId: TabId,
    method: string,
    params?: Record<string, unknown>,
  ): Promise<T>;

  /**
   * Get info about the tab the agent currently targets. The driver decides
   * what "active" means — the extension uses its pinned-target logic from
   * `active-tab.ts`; Playwright uses the page handed to its constructor.
   * Throws if no targetable tab exists (e.g. only chrome:// pages open).
   */
  getActiveTab(): Promise<BrowserTabInfo>;

  /**
   * Get info about a specific tab by id. Throws if the tab no longer
   * exists. Used by tools that resolve a `tab` arg (a stable handle) to a
   * concrete tab — they do not want the driver's "active" notion.
   */
  getTab(tabId: TabId): Promise<BrowserTabInfo>;

  /** Pin a specific tab as the agent's working target. */
  setActiveTab(tabId: TabId | null): Promise<void>;

  /** The currently-pinned tab id, if any. Synchronous because tools sometimes
   *  need to peek before doing async work. */
  getActiveTabId(): TabId | null;

  /**
   * List all tabs the agent can see. Excludes browser-internal pages
   * (chrome://, chrome-extension://, devtools://) so the agent never
   * accidentally targets its own UI.
   */
  listTabs(): Promise<BrowserTabInfo[]>;

  /**
   * Navigate an existing tab to a new URL. Returns once the navigation has
   * been initiated; callers should `waitForLoad` separately if they need
   * the page settled.
   */
  updateTabUrl(tabId: TabId, url: string): Promise<void>;

  /**
   * Open a new tab at the given URL. By default the new tab is created in
   * the background (not focused) so the agent doesn't steal focus from the
   * user's current tab.
   */
  createTab(url: string, opts?: { active?: boolean }): Promise<TabId>;

  /** Wait until a tab fires its `complete` lifecycle event. */
  waitForLoad(tabId: TabId, timeoutMs?: number): Promise<void>;

  /** Close a tab. */
  closeTab(tabId: TabId): Promise<void>;

  /**
   * Send a message to the content script running in a tab. Used by the
   * legacy "click by CSS selector" fallback path that posts a
   * `CHAT_CLICK_ELEMENT` message. Playwright implementations satisfy this by
   * `page.evaluate()`-ing the equivalent DOM operation; bench harness can
   * also no-op these if a task never hits the fallback path.
   */
  sendToContentScript<T = unknown>(
    tabId: TabId,
    message: Record<string, unknown>,
  ): Promise<T>;
}

/**
 * Production `BrowserDriver` for the Chrome extension runtime.
 *
 * This class is a thin adapter over the existing extension utilities:
 *
 *   - `sendCommand` from `cdp-session.ts` (with detach-and-retry handling)
 *   - tab targeting from `active-tab.ts` (with pinned-target semantics)
 *   - `chrome.tabs.*` for create/update/list/close
 *   - `chrome.tabs.sendMessage` for the legacy CSS-selector fallback path
 *
 * The driver intentionally re-uses those modules rather than reimplementing
 * their logic so that production behavior is byte-identical before and after
 * the refactor. Once all tools have migrated to the driver, the legacy
 * top-level functions can be removed in a follow-up cleanup.
 */

import {
  getActiveUserTab,
  getTargetTabId,
  sendToContentScript as sendToContentScriptLegacy,
  setTargetTabId,
  waitForTabLoad,
} from "../active-tab";
import { sendCommand as sendCdpCommand } from "../cdp-session";
import type {
  BrowserDriver,
  BrowserTabInfo,
  TabId,
} from "./browser-driver";

function isInternalUrl(url: string | undefined): boolean {
  if (!url) return false;
  return (
    url.startsWith("chrome://") ||
    url.startsWith("chrome-extension://") ||
    url.startsWith("devtools://")
  );
}

function toBrowserTabInfo(tab: chrome.tabs.Tab): BrowserTabInfo {
  return {
    id: tab.id ?? -1,
    url: tab.url ?? "",
    title: tab.title ?? "",
    active: tab.active,
    favIconUrl: tab.favIconUrl,
    pinned: tab.pinned,
  };
}

export class ExtensionDriver implements BrowserDriver {
  async sendCommand<T = unknown>(
    tabId: TabId,
    method: string,
    params?: Record<string, unknown>,
  ): Promise<T> {
    return sendCdpCommand<T>(tabId as number, method, params);
  }

  async getActiveTab(): Promise<BrowserTabInfo> {
    const tab = await getActiveUserTab();
    return toBrowserTabInfo(tab);
  }

  async setActiveTab(tabId: TabId | null): Promise<void> {
    setTargetTabId(tabId == null ? null : (tabId as number));
  }

  getActiveTabId(): TabId | null {
    return getTargetTabId();
  }

  async listTabs(): Promise<BrowserTabInfo[]> {
    const window = await chrome.windows.getCurrent();
    if (!window.id) return [];
    const tabs = await chrome.tabs.query({ windowId: window.id });
    return tabs
      .filter((t) => !isInternalUrl(t.url))
      .map(toBrowserTabInfo);
  }

  async updateTabUrl(tabId: TabId, url: string): Promise<void> {
    await chrome.tabs.update(tabId as number, { url });
  }

  async createTab(
    url: string,
    opts: { active?: boolean } = {},
  ): Promise<TabId> {
    const tab = await chrome.tabs.create({
      url,
      active: opts.active ?? false,
    });
    return tab.id!;
  }

  async waitForLoad(tabId: TabId, timeoutMs?: number): Promise<void> {
    await waitForTabLoad(tabId as number, timeoutMs);
  }

  async closeTab(tabId: TabId): Promise<void> {
    await chrome.tabs.remove(tabId as number);
  }

  async sendToContentScript<T = unknown>(
    tabId: TabId,
    message: Record<string, unknown>,
  ): Promise<T> {
    return sendToContentScriptLegacy<T>(tabId as number, message);
  }
}

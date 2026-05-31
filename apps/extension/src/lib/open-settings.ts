/**
 * Open the settings page, reusing an existing settings tab instead of
 * spawning a duplicate.
 *
 * Every entry point that wants to show settings (the home/overlay hotkeys,
 * the HomeSidebar button, the overlay command item, the logo menu, the
 * sidepanel menu, chat menus, the landing page) routes through here so the
 * behaviour is consistent: if a `settings.html` tab is already open, focus
 * it (and switch its sub-tab if requested) rather than creating another.
 *
 * Works from any extension context that has `chrome.tabs` (background,
 * extension pages). The optional `subTab` selects the `?tab=` sub-section
 * (e.g. "models").
 */

const SETTINGS_PAGE = "/settings.html";

export async function openSettingsTab(subTab?: string): Promise<void> {
  const baseUrl = chrome.runtime.getURL(SETTINGS_PAGE);
  const targetUrl = subTab
    ? `${baseUrl}?tab=${encodeURIComponent(subTab)}`
    : baseUrl;

  let existing: chrome.tabs.Tab | undefined;
  try {
    const tabs = await chrome.tabs.query({ url: `${baseUrl}*` });
    existing = tabs.find((t) => t.id != null);
  } catch {
    existing = undefined;
  }

  if (existing?.id != null) {
    // Switch the sub-tab when one was requested and it differs from the
    // currently-open one; otherwise just activate the existing tab.
    const needsNav = subTab != null && existing.url !== targetUrl;
    await chrome.tabs.update(existing.id, {
      active: true,
      ...(needsNav ? { url: targetUrl } : {}),
    });
    if (existing.windowId != null) {
      try {
        await chrome.windows.update(existing.windowId, { focused: true });
      } catch {
        // Window may not be focusable (e.g. minimized externally); ignore.
      }
    }
    return;
  }

  await chrome.tabs.create({ url: targetUrl });
}

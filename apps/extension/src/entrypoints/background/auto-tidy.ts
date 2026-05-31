import { storage } from "@/lib/storage";
import { AUTO_TIDY_CHECK_INTERVAL_MS } from "@/lib/constants";

let lastTidyTimestamp = Date.now();

export function startAutoTidy(): void {
  chrome.alarms.create("auto-tidy", {
    periodInMinutes: AUTO_TIDY_CHECK_INTERVAL_MS / 60_000,
  });

  chrome.alarms.onAlarm.addListener(async (alarm) => {
    if (alarm.name !== "auto-tidy") return;
    await checkAndAutoTidy();
  });
}

export function updateLastTidyTimestamp(): void {
  lastTidyTimestamp = Date.now();
}

async function checkAndAutoTidy(): Promise<void> {
  const settings = await storage.getSettings();

  // Auto-close completed agent-owned tabs (replaces the old idle-ungroup
  // behavior). No-op unless the user enabled the setting.
  const { cleanupCompletedAgentTabs } = await import("./tab-scoping");
  await cleanupCompletedAgentTabs({
    enabled: settings.autoCloseCompletedAgentTabs,
    timeoutMinutes: settings.autoCloseCompletedAgentTabsAfterMinutes,
  }).catch(() => {});

  const thresholdMs = settings.autoTidyAfterMinutes * 60_000;
  const now = Date.now();

  if (now - lastTidyTimestamp < thresholdMs) return;

  const focusedWindows = await chrome.windows.getAll({ populate: false });
  const focused = focusedWindows.find((w) => w.focused);
  if (!focused?.id) return;

  const space = await storage.getSpaceByWindowId(focused.id);
  if (!space) return;

  const favoriteUrls = new Set(space.favorites.map((f) => f.url));
  const homePageUrl = chrome.runtime.getURL("/home.html");
  const sidepanelUrl = chrome.runtime.getURL("/sidepanel.html");

  const { isTabOwned } = await import("./tab-scoping");
  const allTabs = await chrome.tabs.query({ windowId: focused.id });
  const eligibleTabs = allTabs.filter(
    (t) =>
      t.id &&
      t.url &&
      !t.pinned &&
      !t.url.startsWith("chrome://") &&
      !t.url.startsWith("chrome-extension://") &&
      !t.url.startsWith(homePageUrl) &&
      !t.url.startsWith(sidepanelUrl) &&
      !favoriteUrls.has(t.url) &&
      !isTabOwned(t.id),
  );

  if (eligibleTabs.length === 0) return;

  const tabData = eligibleTabs.map((t) => ({
    id: String(t.id!),
    url: t.url!,
    title: t.title ?? "Untitled",
  }));

  try {
    const { ensureOffscreenDocument } = await import("./messages");
    await ensureOffscreenDocument();
    const { sendToOffscreen } = await import("@/lib/messages");
    const enriched = await enrichWithSettings({ type: "SORT_TABS", tabs: tabData });
    const result = (await sendToOffscreen(enriched)) as {
      archivedTabIds?: string[];
      sections?: unknown[];
      error?: string;
    };

    if (result?.archivedTabIds?.length) {
      const tabIdsToClose = result.archivedTabIds
        .map((id: string) => Number(id))
        .filter((id: number) => !Number.isNaN(id));
      if (tabIdsToClose.length > 0) {
        await chrome.tabs.remove(tabIdsToClose);
      }
    }

    if (result && !result.error) {
      await storage.setAutoTidyNotification({
        timestamp: Date.now(),
        archivedCount: result.archivedTabIds?.length ?? 0,
        sectionCount: result.sections?.length ?? 0,
        tabCount: tabData.length,
      });

      chrome.runtime.sendMessage({
        type: "TIDY_RESULT",
        result,
      }).catch(() => {});
    }
  } catch {
    // Auto-tidy is best-effort
  }

  lastTidyTimestamp = Date.now();
}

export async function enrichWithSettings(message: any) {
  const settings = await storage.getSettings();
  return {
    ...message,
    provider: settings.aiProvider,
    modelId:
      settings.aiProvider === "cloud"
        ? settings.cloudModel
        : settings.webllmModel,
    archiveAggressiveness: settings.archiveAggressiveness,
    ...(settings.aiProvider === "cloud"
      ? {
          cloudConfig: {
            cloudProvider: settings.cloudProvider,
            cloudApiKey: settings.cloudApiKey,
            cloudModel: settings.cloudModel,
            cloudBaseUrl: settings.cloudBaseUrl,
          },
        }
      : {}),
  };
}

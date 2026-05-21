import { useEffect, useState } from "react";
import { HOME_PAGE_URL } from "@/lib/constants";

interface RecentTab {
  id: number;
  title: string;
  url: string;
  favicon: string;
  lastAccessed: number;
}

export function useRecentTabs(windowId: number | null, limit = 5): RecentTab[] {
  const [recentTabs, setRecentTabs] = useState<RecentTab[]>([]);

  useEffect(() => {
    if (!windowId) return;

    const homeUrl = chrome.runtime.getURL(HOME_PAGE_URL);

    async function fetchTabs() {
      const tabs = await chrome.tabs.query({ windowId: windowId! });
      const filtered = tabs
        .filter(
          (t) =>
            t.id &&
            t.url &&
            !t.url.startsWith(homeUrl) &&
            !t.url.startsWith("chrome://") &&
            !t.url.startsWith("chrome-extension://"),
        )
        .map((t) => ({
          id: t.id!,
          title: t.title || "Untitled",
          url: t.url!,
          favicon: t.favIconUrl || "",
          lastAccessed: t.lastAccessed ?? 0,
        }))
        .sort((a, b) => b.lastAccessed - a.lastAccessed)
        .slice(0, limit);

      setRecentTabs(filtered);
    }

    fetchTabs();

    const onActivated = (info: chrome.tabs.OnActivatedInfo) => {
      if (info.windowId === windowId) fetchTabs();
    };
    const onUpdated = () => fetchTabs();
    const onRemoved = () => fetchTabs();

    chrome.tabs.onActivated.addListener(onActivated);
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.onRemoved.addListener(onRemoved);

    return () => {
      chrome.tabs.onActivated.removeListener(onActivated);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.tabs.onRemoved.removeListener(onRemoved);
    };
  }, [windowId, limit]);

  return recentTabs;
}

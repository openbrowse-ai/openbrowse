import { useCallback, useEffect, useRef, useState } from "react";

export interface ActiveTab {
  id: number;
  url: string;
  title: string;
  favicon: string;
  pinned: boolean;
  active: boolean;
  index: number;
}

export function useActiveTabs(windowId: number | null): ActiveTab[] {
  const [activeTabs, setActiveTabs] = useState<ActiveTab[]>([]);
  const windowIdRef = useRef(windowId);
  windowIdRef.current = windowId;

  const refresh = useCallback(async () => {
    const wid = windowIdRef.current;
    if (wid === null) {
      setActiveTabs([]);
      return;
    }
    try {
      const tabs = await chrome.tabs.query({ windowId: wid });
      const homePageUrl = chrome.runtime.getURL("/home.html");
      const sidepanelUrl = chrome.runtime.getURL("/sidepanel.html");
      setActiveTabs(
        tabs
          .filter(
            (t) =>
              t.url &&
              !t.url.startsWith(homePageUrl) &&
              !t.url.startsWith(sidepanelUrl),
          )
          .map((t) => ({
            id: t.id!,
            url: t.url ?? "",
            title: t.title ?? "Untitled",
            favicon: t.favIconUrl ?? "",
            pinned: t.pinned ?? false,
            active: t.active ?? false,
            index: t.index ?? 0,
          }))
          .sort((a, b) => a.index - b.index),
      );
    } catch {
      setActiveTabs([]);
    }
  }, []);

  useEffect(() => {
    refresh();

    const onCreated = () => refresh();
    const onRemoved = () => refresh();
    const onMoved = () => refresh();
    const onUpdated = () => refresh();
    const onDetached = () => refresh();
    const onAttached = () => refresh();
    const onActivated = () => refresh();

    chrome.tabs.onCreated.addListener(onCreated);
    chrome.tabs.onRemoved.addListener(onRemoved);
    chrome.tabs.onMoved.addListener(onMoved);
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.onDetached.addListener(onDetached);
    chrome.tabs.onAttached.addListener(onAttached);
    chrome.tabs.onActivated.addListener(onActivated);

    const onWindowFocused = (wid: number) => {
      if (wid !== chrome.windows.WINDOW_ID_NONE) refresh();
    };
    chrome.windows.onFocusChanged.addListener(onWindowFocused);

    const interval = setInterval(refresh, 3000);

    return () => {
      chrome.tabs.onCreated.removeListener(onCreated);
      chrome.tabs.onRemoved.removeListener(onRemoved);
      chrome.tabs.onMoved.removeListener(onMoved);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.tabs.onDetached.removeListener(onDetached);
      chrome.tabs.onAttached.removeListener(onAttached);
      chrome.tabs.onActivated.removeListener(onActivated);
      chrome.windows.onFocusChanged.removeListener(onWindowFocused);
      clearInterval(interval);
    };
  }, [refresh, windowId]);

  return activeTabs;
}

export interface TabHandle {
  handle: string;
  chromeTabId: number;
}

interface HandleMap {
  handleToTab: Map<string, number>;
  tabToHandle: Map<number, string>;
  counter: number;
}

const maps = new Map<string, HandleMap>();

function getMap(conversationId: string): HandleMap {
  let map = maps.get(conversationId);
  if (!map) {
    map = { handleToTab: new Map(), tabToHandle: new Map(), counter: 1 };
    maps.set(conversationId, map);
  }
  return map;
}

export function getOrCreateHandle(conversationId: string, tabId: number): string {
  const map = getMap(conversationId);
  const existing = map.tabToHandle.get(tabId);
  if (existing) return existing;

  const handle = `t${map.counter++}`;
  map.handleToTab.set(handle, tabId);
  map.tabToHandle.set(tabId, handle);
  return handle;
}

export function resolveHandle(conversationId: string, handle: string): number | undefined {
  return maps.get(conversationId)?.handleToTab.get(handle);
}

export function clearHandles(conversationId: string): void {
  maps.delete(conversationId);
}

chrome.tabs.onRemoved.addListener((tabId) => {
  for (const map of maps.values()) {
    const handle = map.tabToHandle.get(tabId);
    if (handle) {
      map.handleToTab.delete(handle);
      map.tabToHandle.delete(tabId);
    }
  }
});

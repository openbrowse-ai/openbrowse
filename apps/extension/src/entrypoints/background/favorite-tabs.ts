import type { FavoriteTabAssociation, Space } from "@/lib/types";

const associations = new Map<string, Map<string, FavoriteTabAssociation>>();

function getSpaceMap(spaceId: string): Map<string, FavoriteTabAssociation> {
  let map = associations.get(spaceId);
  if (!map) {
    map = new Map();
    associations.set(spaceId, map);
  }
  return map;
}

export function associate(
  spaceId: string,
  favoriteUrl: string,
  tabId: number,
  currentUrl: string,
  currentTitle: string,
  currentFavicon: string,
) {
  getSpaceMap(spaceId).set(favoriteUrl, {
    favoriteUrl,
    tabId,
    currentUrl,
    currentTitle,
    currentFavicon,
  });
}

export function disassociateByTab(tabId: number) {
  for (const map of associations.values()) {
    for (const [url, assoc] of map) {
      if (assoc.tabId === tabId) {
        map.delete(url);
        return;
      }
    }
  }
}

export function disassociateByFavorite(spaceId: string, favoriteUrl: string) {
  associations.get(spaceId)?.delete(favoriteUrl);
}

export function getAssociations(spaceId: string): FavoriteTabAssociation[] {
  return [...(associations.get(spaceId)?.values() ?? [])];
}

export function getAssociatedTabIds(spaceId: string): Set<number> {
  const map = associations.get(spaceId);
  if (!map) return new Set();
  return new Set([...map.values()].map((a) => a.tabId));
}

export function updateTabInfo(
  tabId: number,
  url?: string,
  title?: string,
  favicon?: string,
) {
  for (const map of associations.values()) {
    for (const assoc of map.values()) {
      if (assoc.tabId === tabId) {
        if (url !== undefined) assoc.currentUrl = url;
        if (title !== undefined) assoc.currentTitle = title;
        if (favicon !== undefined) assoc.currentFavicon = favicon;
        return;
      }
    }
  }
}

export async function bootstrap(spaces: Space[]) {
  associations.clear();
  for (const space of spaces) {
    if (!space.windowId || space.favorites.length === 0) continue;
    let tabs: chrome.tabs.Tab[];
    try {
      tabs = await chrome.tabs.query({ windowId: space.windowId });
    } catch {
      continue;
    }
    for (const fav of space.favorites) {
      const match =
        tabs.find((t) => t.url === fav.url && t.active) ??
        tabs.find((t) => t.url === fav.url);
      if (match?.id) {
        associate(
          space.id,
          fav.url,
          match.id,
          match.url ?? fav.url,
          match.title ?? fav.title,
          match.favIconUrl ?? fav.favicon,
        );
      }
    }
  }
}

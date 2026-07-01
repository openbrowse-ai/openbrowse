import { storage } from "@/lib/storage";

export interface WindowInfo {
  windowId: number;
  focused: boolean;
  incognito: boolean;
  tabCount: number;
  activeTab: { id: number; url: string; title: string } | null;
  space: { id: string; name: string; description: string | null } | null;
}

export interface GetContextResult {
  focusedWindowId: number | null;
  windows: WindowInfo[];
  brokerVersion: string;
  extensionVersion: string;
}

export async function handleGetContext(
  _params: unknown,
  _ctx?: import("../index").RpcHandlerContext,
): Promise<GetContextResult> {
  const windows = await chrome.windows.getAll();
  const spaces = await storage.getSpaces();
  const spacesByWindowId = new Map<number, (typeof spaces)[number]>();
  for (const s of spaces) if (s.windowId !== null) spacesByWindowId.set(s.windowId, s);

  const focusedWindow = windows.find((w) => w.focused);
  const windowInfos: WindowInfo[] = [];

  for (const win of windows) {
    if (!win.id) continue;
    const allTabs = await chrome.tabs.query({ windowId: win.id });
    const activeTabs = await chrome.tabs.query({ windowId: win.id, active: true });
    const active = activeTabs[0];
    const space = spacesByWindowId.get(win.id);
    windowInfos.push({
      windowId: win.id,
      focused: !!win.focused,
      incognito: !!win.incognito,
      tabCount: allTabs.length,
      activeTab: active && active.id !== undefined && active.url !== undefined
        ? { id: active.id, url: active.url, title: active.title ?? "" }
        : null,
      space: space ? { id: space.id, name: space.name, description: space.description } : null,
    });
  }

  return {
    focusedWindowId: focusedWindow?.id ?? null,
    windows: windowInfos,
    brokerVersion: "0.0.0",
    extensionVersion: chrome.runtime.getManifest().version,
  };
}

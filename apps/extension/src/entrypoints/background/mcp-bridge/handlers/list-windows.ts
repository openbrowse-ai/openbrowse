import { storage } from "@/lib/storage";
import type { WindowInfo } from "./get-context";

export interface ListWindowsResult {
  windows: WindowInfo[];
}

export async function handleListWindows(
  _params: unknown,
  _ctx?: import("../index").RpcHandlerContext,
): Promise<ListWindowsResult> {
  const windows = await chrome.windows.getAll();
  const spaces = await storage.getSpaces();
  const spacesByWindowId = new Map<number, (typeof spaces)[number]>();
  for (const s of spaces) if (s.windowId !== null) spacesByWindowId.set(s.windowId, s);

  const out: WindowInfo[] = [];
  for (const win of windows) {
    if (!win.id) continue;
    const allTabs = await chrome.tabs.query({ windowId: win.id });
    const activeTabs = await chrome.tabs.query({ windowId: win.id, active: true });
    const active = activeTabs[0];
    const space = spacesByWindowId.get(win.id);
    out.push({
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
  return { windows: out };
}

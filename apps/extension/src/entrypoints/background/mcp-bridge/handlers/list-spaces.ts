import { storage } from "@/lib/storage";

export interface SpaceInfo {
  id: string;
  name: string;
  description: string | null;
  position: number;
  bound: boolean;
  windowId: number | null;
  hasInstructions: boolean;
}

export interface ListSpacesResult {
  spaces: SpaceInfo[];
}

async function windowExists(windowId: number): Promise<boolean> {
  try {
    await chrome.windows.get(windowId);
    return true;
  } catch {
    return false;
  }
}

export async function handleListSpaces(
  _params: unknown,
  _ctx?: import("../index").RpcHandlerContext,
): Promise<ListSpacesResult> {
  const spaces = await storage.getSpaces();
  const out: SpaceInfo[] = [];
  for (const s of spaces) {
    let bound = false;
    if (s.windowId !== null) bound = await windowExists(s.windowId);
    out.push({
      id: s.id,
      name: s.name,
      description: s.description,
      position: s.position,
      bound,
      windowId: s.windowId,
      hasInstructions: typeof s.instructions === "string" && s.instructions.trim().length > 0,
    });
  }
  return { spaces: out };
}

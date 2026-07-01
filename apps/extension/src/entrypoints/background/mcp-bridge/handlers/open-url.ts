class RpcError extends Error {
  constructor(message: string, public readonly code: string) { super(message); }
}

export interface OpenUrlParams {
  url: string;
  windowId?: number;
  active?: boolean;
}

export interface OpenUrlResult {
  tabId: number;
  windowId: number;
  url: string;
}

const ALLOWED_SCHEMES = new Set(["http:", "https:"]);

export async function handleOpenUrl(
  rawParams: unknown,
  _ctx: { authContext: { sub: string; client_name?: string }; emitEvent: (e: unknown) => void },
): Promise<OpenUrlResult> {
  const params = (rawParams ?? {}) as Partial<OpenUrlParams>;
  if (typeof params.url !== "string" || params.url.length === 0) {
    throw new RpcError("missing required parameter: url", "invalid_params");
  }

  let parsed: URL;
  try { parsed = new URL(params.url); } catch {
    throw new RpcError("invalid url", "invalid_url");
  }
  if (!ALLOWED_SCHEMES.has(parsed.protocol)) {
    throw new RpcError(`scheme not allowed: ${parsed.protocol}`, "invalid_url");
  }

  let targetWindowId: number;
  if (typeof params.windowId === "number") {
    try { await chrome.windows.get(params.windowId); } catch {
      throw new RpcError(`window not found: ${params.windowId}`, "window_not_found");
    }
    targetWindowId = params.windowId;
  } else {
    const win = await chrome.windows.getCurrent();
    if (!win.id) throw new RpcError("no focused window", "no_focused_window");
    targetWindowId = win.id;
  }

  const tab = await chrome.tabs.create({
    windowId: targetWindowId,
    url: params.url,
    active: params.active ?? false,
  });

  if (typeof tab.id !== "number") {
    throw new RpcError("could not open tab", "internal_error");
  }

  return { tabId: tab.id, windowId: targetWindowId, url: params.url };
}

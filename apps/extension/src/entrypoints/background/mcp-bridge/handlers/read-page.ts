import { captureSnapshot } from "@/lib/agent/snapshot-capture";

export interface ReadPageParams {
  tabId?: number;
  format?: "snapshot" | "text" | "html";
  scopeSelector?: string;
}

export interface ReadPageResult {
  url: string;
  title: string;
  format: "snapshot" | "text" | "html";
  content: string;
}

interface ExtractedContent {
  url: string;
  title: string;
  h1: string | null;
  bodyText: string;
  links: { href: string; text: string }[];
  description: string | null;
}

async function resolveTabId(params: ReadPageParams): Promise<number> {
  if (typeof params.tabId === "number") {
    try {
      await chrome.tabs.get(params.tabId);
      return params.tabId;
    } catch {
      throw new Error("tab_not_found");
    }
  }
  const currentWindow = await chrome.windows.getCurrent();
  if (!currentWindow.id) throw new Error("no focused window");
  const tabs = await chrome.tabs.query({ windowId: currentWindow.id, active: true });
  const tab = tabs[0];
  if (!tab || typeof tab.id !== "number") throw new Error("tab_not_found");
  return tab.id;
}

export async function handleReadPage(
  rawParams: unknown,
  _ctx?: import("../index").RpcHandlerContext,
): Promise<ReadPageResult> {
  const params = (rawParams ?? {}) as ReadPageParams;
  const tabId = await resolveTabId(params);
  const tab = await chrome.tabs.get(tabId);
  const format = params.format ?? "snapshot";

  if (format === "snapshot") {
    // Use the same ExtensionDriver class the agent transport uses
    // (see apps/extension/src/lib/agent/agent-transport.ts which does:
    //   `const extensionDriver = new ExtensionDriver();`).
    // We instantiate a fresh driver here — it's stateless apart from
    // CDP attach state which is per-tab/per-call.
    const { ExtensionDriver } = await import("@/lib/agent/driver/extension-driver");
    const driver = new ExtensionDriver();
    const snap = await captureSnapshot(driver as never, tabId, {
      mode: "interactive",
      selector: params.scopeSelector,
    });
    return {
      url: tab.url ?? "",
      title: tab.title ?? "",
      format: "snapshot",
      content: snap.snapshotText,
    };
  }

  // text/html via content script
  const extracted = (await chrome.tabs.sendMessage(tabId, {
    type: "CHAT_EXTRACT_CONTENT",
  })) as ExtractedContent;

  if (format === "text") {
    const lines: string[] = [];
    if (extracted.h1) lines.push(`# ${extracted.h1}`);
    if (extracted.description) lines.push(extracted.description);
    lines.push(extracted.bodyText);
    return {
      url: extracted.url,
      title: extracted.title,
      format: "text",
      content: lines.filter(Boolean).join("\n\n"),
    };
  }

  // html — return body text as a simple fallback for Phase 1; richer
  // html extraction is a Phase 2 enhancement.
  return {
    url: extracted.url,
    title: extracted.title,
    format: "html",
    content: extracted.bodyText,
  };
}

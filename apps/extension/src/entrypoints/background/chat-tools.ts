export async function executeReadPage(tabId: number): Promise<{
  success: boolean;
  data?: {
    url: string;
    title: string;
    h1: string;
    description: string;
    bodyText: string;
    links: { text: string; href: string }[];
  };
  error?: string;
}> {
  try {
    const response = await chrome.tabs.sendMessage(tabId, {
      type: "CHAT_EXTRACT_CONTENT",
    });
    return { success: true, data: response };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function executeScreenshot(): Promise<{
  success: boolean;
  data?: string;
  error?: string;
}> {
  try {
    const dataUrl = await chrome.tabs.captureVisibleTab({
      format: "png",
    });
    return { success: true, data: dataUrl };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function listSpaceTabs(windowId: number): Promise<{
  success: boolean;
  data?: { id: number; url: string; title: string; active: boolean }[];
  error?: string;
}> {
  try {
    const tabs = await chrome.tabs.query({ windowId });
    return {
      success: true,
      data: tabs
        .filter((t) => t.id && t.url)
        .map((t) => ({
          id: t.id!,
          url: t.url!,
          title: t.title || "",
          active: t.active || false,
        })),
    };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

import type { BrowserDriver, TabId } from "../driver";
import type { CanonicalAction, ModifierKey } from "./actions";
import { modifierMask, dispatchKeyCombo } from "../keyboard";

async function mouse(
  driver: BrowserDriver,
  tabId: TabId,
  params: Record<string, unknown>,
): Promise<void> {
  await driver.sendCommand(tabId, "Input.dispatchMouseEvent", params);
}

/**
 * Run a single provider-neutral action against a tab via CDP. Coordinates
 * must already be CSS pixels. Returns nothing; the caller captures a fresh
 * screenshot afterward.
 */
export async function executeCanonicalAction(
  driver: BrowserDriver,
  tabId: TabId,
  action: CanonicalAction,
): Promise<void> {
  switch (action.kind) {
    case "move":
      await mouse(driver, tabId, { type: "mouseMoved", x: action.x, y: action.y });
      return;

    case "click": {
      const button = action.button ?? "left";
      const clickCount = action.clickCount ?? 1;
      const modifiers = modifierMask(action.modifiers);
      await mouse(driver, tabId, { type: "mouseMoved", x: action.x, y: action.y, modifiers });
      await mouse(driver, tabId, { type: "mousePressed", x: action.x, y: action.y, button, clickCount, modifiers });
      await mouse(driver, tabId, { type: "mouseReleased", x: action.x, y: action.y, button, clickCount, modifiers });
      return;
    }

    case "drag":
      await mouse(driver, tabId, { type: "mouseMoved", x: action.x, y: action.y });
      await mouse(driver, tabId, { type: "mousePressed", x: action.x, y: action.y, button: "left", clickCount: 1 });
      await mouse(driver, tabId, { type: "mouseMoved", x: action.toX, y: action.toY, button: "left" });
      await mouse(driver, tabId, { type: "mouseReleased", x: action.toX, y: action.toY, button: "left", clickCount: 1 });
      return;

    case "scroll":
      await mouse(driver, tabId, {
        type: "mouseWheel",
        x: action.x,
        y: action.y,
        deltaX: action.deltaX,
        deltaY: action.deltaY,
      });
      return;

    case "type":
      await driver.sendCommand(tabId, "Input.insertText", { text: action.text });
      return;

    case "key":
      await dispatchKeyCombo(driver, tabId, action.keys);
      return;

    case "holdKey":
      await dispatchKeyCombo(driver, tabId, action.keys, action.ms);
      return;

    // mouseDown/mouseUp are independent half-clicks (the model positions and
    // presses/releases in separate steps), so unlike `click`/`drag` they
    // intentionally omit the leading `mouseMoved`.
    case "mouseDown":
      await mouse(driver, tabId, { type: "mousePressed", x: action.x, y: action.y, button: action.button ?? "left", clickCount: 1 });
      return;

    case "mouseUp":
      await mouse(driver, tabId, { type: "mouseReleased", x: action.x, y: action.y, button: action.button ?? "left", clickCount: 1 });
      return;

    case "wait":
      await new Promise((r) => setTimeout(r, action.ms));
      return;

    case "navigate":
      await driver.updateTabUrl(tabId, action.url);
      await driver.waitForLoad(tabId, 5000).catch(() => {});
      return;

    case "goBack":
    case "goForward": {
      const hist = await driver.sendCommand<{
        currentIndex: number;
        entries: Array<{ id: number; url: string }>;
      }>(tabId, "Page.getNavigationHistory");
      const targetIdx = action.kind === "goBack" ? hist.currentIndex - 1 : hist.currentIndex + 1;
      const entry = hist.entries[targetIdx];
      if (!entry) return; // no history in that direction — no-op
      await driver.sendCommand(tabId, "Page.navigateToHistoryEntry", { entryId: entry.id });
      await driver.waitForLoad(tabId, 5000).catch(() => {});
      return;
    }

    case "zoom":
    case "screenshot":
    case "done":
      // No CDP side effect. `zoom`/`screenshot` capture is handled by the
      // loop; `done` terminates the loop.
      return;
  }
}

/**
 * Capture a viewport PNG and return base64 (no data: prefix). Mirrors the
 * retry behavior of tools/screenshot.ts.
 */
export async function captureViewportShot(
  driver: BrowserDriver,
  tabId: TabId,
): Promise<string> {
  try {
    const r = await driver.sendCommand<{ data: string }>(
      tabId,
      "Page.captureScreenshot",
      { format: "png" },
    );
    return r.data;
  } catch {
    await new Promise((r) => setTimeout(r, 600));
    const r = await driver.sendCommand<{ data: string }>(
      tabId,
      "Page.captureScreenshot",
      { format: "png" },
    );
    return r.data;
  }
}

import { openHomePage } from "./messages";
import { isAutoHomeOwned } from "./spaces";

/**
 * Auto-home handler for `chrome.windows.onCreated`. Lives in its own module
 * so vitest can import and exercise it directly without booting the full
 * `defineBackground({ main })` body in `./index.ts` (which depends on the
 * WXT auto-imported `defineBackground` and is hostile to test loading).
 *
 * Behavior:
 *   - Only acts on `type: "normal"` windows.
 *   - Bails when the window was created by `focusOrCreateWindow` (it already
 *     injected an anchored home tab and marked the window via
 *     `markAutoHomeOwned`).
 *   - Otherwise, calls `openHomePage(windowId)`, which creates and pins the
 *     home tab if missing or repairs an existing un-pinned one.
 *
 * Race note: `focusOrCreateWindow` can only call `markAutoHomeOwned(id)`
 * AFTER `await chrome.windows.create(...)` resolves (the id isn't known
 * before then), but Chrome can dispatch `onCreated` to this listener BEFORE
 * that await resolves in the creator. Without a yield here, the gate flag
 * isn't set yet when we read it, so we'd inject a duplicate home tab on
 * top of the one `focusOrCreateWindow` just created. We defer one macrotask
 * so the creator's continuation has a chance to run `markAutoHomeOwned`
 * first. `openHomePage` is also hardened to match home tabs by
 * `pendingUrl` so it won't double-create even if this guard misses.
 */
export async function handleNewWindowAutoHome(
  win: chrome.windows.Window,
): Promise<void> {
  if (win.id == null) return;
  if (win.type !== "normal") return;
  const windowId = win.id;

  // Yield one macrotask so `focusOrCreateWindow`'s post-`create()`
  // continuation (which calls `markAutoHomeOwned`) gets a chance to run
  // before we check the gate.
  await new Promise<void>((resolve) => setTimeout(resolve, 0));

  if (isAutoHomeOwned(windowId)) return;
  try {
    await openHomePage(windowId);
  } catch {
    // Window vanished, or chrome.tabs API unavailable — ignore.
  }
}

import type { BrowserDriver, TabId } from "./driver";
import type { ModifierKey } from "./cua/actions";

const MODIFIER_BITS: Record<ModifierKey, number> = {
  alt: 1,
  ctrl: 2,
  super: 4, // Meta/Command
  shift: 8,
};

export function modifierMask(mods?: ModifierKey[]): number {
  if (!mods) return 0;
  return mods.reduce((m, k) => m | MODIFIER_BITS[k], 0);
}

/** Minimal key-name → CDP key event params. Extend as needed. */
export function keyEventParams(name: string): {
  key: string;
  code: string;
  windowsVirtualKeyCode?: number;
} {
  const lower = name.toLowerCase();
  switch (lower) {
    case "enter":
    case "return":
      return { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 };
    case "tab":
      return { key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 };
    case "backspace":
      return { key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 };
    case "escape":
    case "esc":
      return { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 };
    case "arrowup":
    case "up":
      return { key: "ArrowUp", code: "ArrowUp", windowsVirtualKeyCode: 38 };
    case "arrowdown":
    case "down":
      return { key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40 };
    case "arrowleft":
    case "left":
      return { key: "ArrowLeft", code: "ArrowLeft", windowsVirtualKeyCode: 37 };
    case "arrowright":
    case "right":
      return { key: "ArrowRight", code: "ArrowRight", windowsVirtualKeyCode: 39 };
    case "delete":
      return { key: "Delete", code: "Delete", windowsVirtualKeyCode: 46 };
    case "home":
      return { key: "Home", code: "Home", windowsVirtualKeyCode: 36 };
    case "end":
      return { key: "End", code: "End", windowsVirtualKeyCode: 35 };
    case "page_up":
    case "pageup":
    case "prior":
      return { key: "PageUp", code: "PageUp", windowsVirtualKeyCode: 33 };
    case "page_down":
    case "pagedown":
    case "next":
      return { key: "PageDown", code: "PageDown", windowsVirtualKeyCode: 34 };
    case "space":
      return { key: " ", code: "Space", windowsVirtualKeyCode: 32 };
    default: {
      // Unknown single-character keys (e.g. "a", "/") are passed through as
      // literal characters. Unknown multi-char keysyms are passed through as
      // the `key` name verbatim rather than truncated to their first char —
      // truncating corrupts input (e.g. "Page_Down" → "P").
      if (name.length === 1) {
        return { key: name, code: `Key${name.toUpperCase()}` };
      }
      return { key: name, code: "" };
    }
  }
}

/** Keys that are modifiers when they appear in a `key` combo. */
const COMBO_MODIFIERS: Record<string, ModifierKey> = {
  ctrl: "ctrl",
  control: "ctrl",
  shift: "shift",
  alt: "alt",
  meta: "super",
  cmd: "super",
  command: "super",
  super: "super",
};

/** Dispatch a key combo (modifiers + one main key). When `holdMs` is given,
 *  the key is held down for that duration before release. */
export async function dispatchKeyCombo(
  driver: BrowserDriver,
  tabId: TabId,
  keys: string[],
  holdMs?: number,
): Promise<void> {
  const mods: ModifierKey[] = [];
  let mainKey: string | undefined;
  for (const k of keys) {
    const mod = COMBO_MODIFIERS[k.toLowerCase()];
    if (mod) {
      mods.push(mod);
    } else if (mainKey !== undefined) {
      // A combo may have at most one non-modifier key. Two main keys (e.g.
      // "a+b") is ambiguous — reject rather than silently dropping the first.
      throw new Error(
        `Ambiguous key combo "${keys.join("+")}": more than one non-modifier key (` +
          `"${mainKey}" and "${k}"). A combo must be zero or more modifiers plus a single key.`,
      );
    } else {
      mainKey = k;
    }
  }
  if (!mainKey) return;
  const modifiers = modifierMask(mods);
  const kp = keyEventParams(mainKey);
  await driver.sendCommand(tabId, "Input.dispatchKeyEvent", {
    type: "keyDown",
    modifiers,
    ...kp,
  });
  if (holdMs && holdMs > 0) await new Promise((r) => setTimeout(r, holdMs));
  await driver.sendCommand(tabId, "Input.dispatchKeyEvent", {
    type: "keyUp",
    modifiers,
    ...kp,
  });
}

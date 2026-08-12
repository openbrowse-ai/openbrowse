/**
 * Keyboard decision logic for {@link QuestionCard}, extracted so it can be
 * tested directly — the project doesn't pull in @testing-library/react and
 * vitest runs in the node env, so the component itself isn't renderable in
 * a test (same reasoning as `HostPolicyDropdown` and `mode-switch`).
 *
 * Worth extracting rather than inlining: the card binds a window-level
 * `keydown` handler whose correctness depends entirely on WHERE focus is,
 * which is exactly the part that is invisible when reading the component
 * and impossible to check by hand across every modifier combination.
 */

/** What a keypress means to the card. */
export type QuestionKeyAction =
  | { kind: "ignore" }
  /** Run the primary button (next question, or submit on the last). */
  | { kind: "primary" }
  /** Resolve the whole call as `dismissed` — the "Skip" button. */
  | { kind: "dismiss" }
  | { kind: "navigate"; delta: -1 | 1 }
  | { kind: "pickOption"; optionIndex: number };

export interface QuestionKeyContext {
  key: string;
  altKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
  /**
   * Focus is in the free-text answer box (or any other text entry), where
   * arrows have to move the caret and digits have to type.
   */
  inTextEntry: boolean;
  /**
   * Focus is on a button. Enter is left alone so the button fires its own
   * `onClick` instead of the handler ALSO running the primary action.
   * Deliberately does not affect arrows or digits — a just-clicked option
   * or arrow keeps focus, and navigation must still work from there.
   */
  onButton: boolean;
  /** More than one question, i.e. there is somewhere to navigate to. */
  multi: boolean;
  optionCount: number;
}

const IGNORE: QuestionKeyAction = { kind: "ignore" };

/**
 * Map a keypress to an action.
 *
 * The one genuinely subtle rule is the arrows. Plain ← / → navigate from
 * ANYWHERE — the scroll body, an option button, a pip, a nav arrow — and
 * are inert only while focus sits in the free-text box, where they must
 * move the caret instead. Since that box is where focus naturally ends up
 * once the user starts typing, Alt/Cmd/Ctrl + ← / → also navigate, and
 * those work from inside the box too.
 */
export function resolveQuestionKeyAction(
  ctx: QuestionKeyContext,
): QuestionKeyAction {
  const { key, altKey, ctrlKey, metaKey, shiftKey } = ctx;
  const modified = Boolean(altKey || ctrlKey || metaKey);

  const delta = key === "ArrowLeft" ? -1 : key === "ArrowRight" ? 1 : 0;
  if (delta !== 0) {
    if (!ctx.multi) return IGNORE;
    // Bare arrows belong to the caret while the text box has focus; a
    // modifier is the escape hatch that still navigates from in there.
    if (ctx.inTextEntry && !modified) return IGNORE;
    return { kind: "navigate", delta };
  }

  if (key === "Enter") {
    if (metaKey || ctrlKey) return { kind: "dismiss" };
    // Shift+Enter is the newline in the free-text box (ChatInput's
    // convention); Alt+Enter isn't ours to claim.
    if (shiftKey || altKey) return IGNORE;
    if (ctx.onButton) return IGNORE;
    return { kind: "primary" };
  }

  if (modified) return IGNORE;
  if (ctx.inTextEntry) return IGNORE;
  if (!/^[1-9]$/.test(key)) return IGNORE;

  const optionIndex = Number(key) - 1;
  if (optionIndex >= ctx.optionCount) return IGNORE;
  return { kind: "pickOption", optionIndex };
}

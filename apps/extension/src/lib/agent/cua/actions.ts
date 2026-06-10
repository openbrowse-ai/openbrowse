/**
 * Provider-neutral browser action. Every CUA provider decodes its model's
 * output into one of these. Coordinates are ALREADY in CSS pixels relative
 * to the tab's viewport (the provider's coordinate mapper has run).
 */
export type CanonicalAction =
  | { kind: "click"; x: number; y: number; button?: "left" | "right" | "middle"; clickCount?: number; modifiers?: ModifierKey[] }
  | { kind: "move"; x: number; y: number }
  | { kind: "drag"; x: number; y: number; toX: number; toY: number }
  | { kind: "scroll"; x: number; y: number; deltaX: number; deltaY: number }
  | { kind: "type"; text: string }
  | { kind: "key"; keys: string[] } // e.g. ["ctrl","a"] or ["Enter"]
  | { kind: "mouseDown"; x: number; y: number; button?: "left" | "right" | "middle" }
  | { kind: "mouseUp"; x: number; y: number; button?: "left" | "right" | "middle" }
  | { kind: "holdKey"; keys: string[]; ms: number }
  | { kind: "wait"; ms: number }
  | { kind: "navigate"; url: string }
  | { kind: "goBack" }
  | { kind: "goForward" }
  // Zoom coords are in DECLARED display space (NOT converted to CSS px like
  // click coords); captureRegionShot maps them to native pixels.
  | { kind: "zoom"; x1: number; y1: number; x2: number; y2: number }
  | { kind: "screenshot" }
  | { kind: "done"; summary: string };

export type ModifierKey = "shift" | "ctrl" | "alt" | "super";

export function isTerminalAction(action: CanonicalAction): boolean {
  return action.kind === "done";
}

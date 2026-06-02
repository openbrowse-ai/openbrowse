import { afterEach, describe, expect, it, vi } from "vitest";
import { buildUndoAction, formatClosedToast, performUndo } from "../agent-tabs-closed-toast";

afterEach(() => vi.unstubAllGlobals());

const undo = (n: number) => ({
  action: "reopen" as const,
  id: "test-undo-id",
  tabs: Array.from({ length: n }, (_, i) => ({ url: `https://x/${i}`, windowId: 1, pinned: false })),
});

describe("formatClosedToast", () => {
  it("pluralizes", () => {
    expect(formatClosedToast(undo(2))).toBe("Closed 2 agent tabs");
  });
  it("singularizes", () => {
    expect(formatClosedToast(undo(1))).toBe("Closed 1 agent tab");
  });
});

describe("performUndo", () => {
  it("sends OVERLAY_UNDO with the undo payload", () => {
    const sent: any[] = [];
    vi.stubGlobal("chrome", { runtime: { sendMessage: (m: any) => { sent.push(m); return Promise.resolve(); } } });
    const u = undo(1);
    performUndo(u);
    expect(sent[0]).toEqual({ type: "OVERLAY_UNDO", undoData: u });
  });
});

describe("buildUndoAction", () => {
  it("onClick sends OVERLAY_UNDO via performUndo", () => {
    const sent: any[] = [];
    vi.stubGlobal("chrome", { runtime: { sendMessage: (m: any) => { sent.push(m); return Promise.resolve(); } } });
    const u = undo(1);
    const action = buildUndoAction(u);
    action.onClick();
    expect(sent[0]).toEqual({ type: "OVERLAY_UNDO", undoData: u });
  });
});

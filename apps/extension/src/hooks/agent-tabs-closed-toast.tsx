export interface AgentTabsClosedUndo {
  action: "reopen";
  /** Stable unique id for this close; makes the reopen idempotent. */
  id: string;
  tabs: { url: string; windowId: number; pinned: boolean }[];
}

export function formatClosedToast(undo: AgentTabsClosedUndo): string {
  const n = undo.tabs.length;
  return `Closed ${n} agent ${n === 1 ? "tab" : "tabs"}`;
}

/** Send the reopen-undo to the background. Shared by the toast button and the ⌘Z shortcut. */
export function performUndo(undo: AgentTabsClosedUndo): void {
  chrome.runtime.sendMessage({ type: "OVERLAY_UNDO", undoData: undo }).catch(() => {});
}

/** Sonner action for the toast: an "Undo ⌘Z" button. Label is JSX (sonner v2 allows ReactNode). */
export function buildUndoAction(undo: AgentTabsClosedUndo): {
  label: React.ReactNode;
  onClick: () => void;
} {
  return {
    label: (
      <span className="inline-flex items-center gap-1">
        Undo
        <kbd className="ml-0.5 inline-flex items-center gap-0.5 rounded border border-white/20 bg-white/10 px-1 py-0.5 text-[10px] font-sans leading-none">
          ⌘Z
        </kbd>
      </span>
    ),
    onClick: () => performUndo(undo),
  };
}

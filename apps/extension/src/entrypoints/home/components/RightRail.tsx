import { useEffect, useRef } from "react";
import type { PanelImperativeHandle, PanelSize } from "react-resizable-panels";
import { AnimatePresence, motion } from "motion/react";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { CoworkPanel } from "./CoworkPanel";
import { FileViewerPanel } from "./FileViewerPanel";

interface RightRailProps {
  conversationId: string;
  /** Selected file path RELATIVE to the workspace root (e.g. `notes.csv`). */
  selectedFile: string | null;
  onSelectFile: (file: string | null) => void;
  /** Imperative handle exposed up so the parent can collapse/expand. */
  railPanelRef: React.RefObject<PanelImperativeHandle | null>;
  /** Width persisted to localStorage and used as defaultSize on mount. */
  initialWidthPx: number;
  onWidthChange: (px: number) => void;
  onOpenChange: (open: boolean) => void;
  /** Center pane (chat) — rendered as the left panel of the resizable group. */
  centerSlot: React.ReactNode;
}

export const RAIL_MIN_PX = 320;
export const RAIL_DEFAULT_PX = 360;
export const RAIL_AUTO_WIDEN_PX = 560;
export const RAIL_AUTO_WIDEN_THRESHOLD_PX = 480;

/**
 * Right-side drawer hosting either the workspace ("Cowork") or a file viewer.
 *
 * Built on shadcn's <ResizablePanelGroup> (react-resizable-panels v4) so the
 * boundary between chat and rail is user-draggable. The rail is collapsible
 * to width 0 — the parent toggles via `railPanelRef.current.collapse() /
 * .expand()`. Width changes are reported via `onWidthChange` and persisted
 * to localStorage by the caller.
 *
 * Workspace ↔ file viewer transitions animate via AnimatePresence.
 */
export function RightRail({
  conversationId,
  selectedFile,
  onSelectFile,
  railPanelRef,
  initialWidthPx,
  onWidthChange,
  onOpenChange,
  centerSlot,
}: RightRailProps) {
  const lastReportedOpenRef = useRef(true);

  // Auto-widen on first transition into file mode if the rail is too narrow
  // for spreadsheets/sheet tabs to read comfortably.
  useEffect(() => {
    if (selectedFile == null) return;
    const handle = railPanelRef.current;
    if (!handle) return;
    const size = handle.getSize?.();
    const px = size?.inPixels ?? 0;
    if (px > 0 && px < RAIL_AUTO_WIDEN_THRESHOLD_PX) {
      handle.resize(`${RAIL_AUTO_WIDEN_PX}px`);
    }
  }, [selectedFile, railPanelRef]);

  const maxRailPx = `${Math.max(
    RAIL_AUTO_WIDEN_PX,
    Math.min(
      900,
      Math.round(
        (typeof window !== "undefined" ? window.innerWidth : 1280) * 0.7,
      ),
    ),
  )}px`;

  return (
    <ResizablePanelGroup orientation="horizontal" className="flex-1 min-w-0">
      <ResizablePanel
        defaultSize={50}
        minSize="400px"
        groupResizeBehavior="preserve-relative-size"
      >
        {centerSlot}
      </ResizablePanel>
      <ResizableHandle />
      <ResizablePanel
        panelRef={railPanelRef}
        defaultSize={`${initialWidthPx}px`}
        minSize={`${RAIL_MIN_PX}px`}
        maxSize={maxRailPx}
        collapsible
        collapsedSize={0}
        groupResizeBehavior="preserve-pixel-size"
        onResize={(panelSize: PanelSize) => {
          const px = panelSize.inPixels;
          if (px > 0) onWidthChange(Math.round(px));
          const open = px > 0;
          if (open !== lastReportedOpenRef.current) {
            lastReportedOpenRef.current = open;
            onOpenChange(open);
          }
        }}
        className="bg-[var(--background)]"
      >
        <div className="relative h-full w-full overflow-hidden">
          <AnimatePresence mode="wait" initial={false}>
            {selectedFile === null ? (
              <motion.div
                key="workspace"
                className="absolute inset-0"
                initial={{ x: 16, opacity: 0 }}
                animate={{ x: 0, opacity: 1 }}
                exit={{ x: 16, opacity: 0 }}
                transition={{ duration: 0.18, ease: "easeOut" }}
              >
                <CoworkPanel
                  conversationId={conversationId}
                  onSelectFile={onSelectFile}
                />
              </motion.div>
            ) : (
              <motion.div
                key="file"
                className="absolute inset-0"
                initial={{ x: -16, opacity: 0 }}
                animate={{ x: 0, opacity: 1 }}
                exit={{ x: -16, opacity: 0 }}
                transition={{ duration: 0.18, ease: "easeOut" }}
              >
                <FileViewerPanel
                  filePath={`conversations/${conversationId}/workspace/${selectedFile}`}
                  fileName={selectedFile.split("/").pop() ?? selectedFile}
                  onClose={() => onSelectFile(null)}
                />
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}

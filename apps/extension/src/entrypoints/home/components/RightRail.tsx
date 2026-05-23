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
  /** Persisted file-viewer width (pixels). */
  fileWidthPx: number;
  onFileWidthChange: (px: number) => void;
  onOpenChange: (open: boolean) => void;
  /** Center pane (chat) — rendered as the left panel of the resizable group. */
  centerSlot: React.ReactNode;
}

/** Fixed width for workspace mode. The user does not resize this. */
export const WORKSPACE_WIDTH_PX = 360;
/** Soft minimum for file mode — auto-widen kicks in below this. */
export const FILE_AUTO_WIDEN_THRESHOLD_PX = 480;
/** Width used by auto-widen when the persisted width is below threshold. */
export const FILE_AUTO_WIDEN_PX = 560;
/** Floor for the panel itself (covers both modes). */
export const RAIL_MIN_PX = 320;

/**
 * Right-side drawer hosting either the workspace ("Cowork") or a file viewer.
 *
 * Two distinct sizing regimes share the panel:
 *
 *   - **Workspace mode** (`selectedFile === null`): width is locked to
 *     `WORKSPACE_WIDTH_PX`. The resize handle is disabled and visually
 *     hidden so the boundary looks like the original fixed-width sidebar.
 *
 *   - **File mode** (`selectedFile !== null`): width is the persisted
 *     `fileWidthPx`, resizable by the user via the handle. On entry, if
 *     the persisted width is below `FILE_AUTO_WIDEN_THRESHOLD_PX`, the rail
 *     auto-widens to `FILE_AUTO_WIDEN_PX`.
 *
 * On exit (X click in the file panel), the rail snaps back to
 * `WORKSPACE_WIDTH_PX` via the imperative handle. Width persistence is
 * gated to file mode only — programmatic snaps to the workspace width
 * never overwrite the user's saved file width.
 */
export function RightRail({
  conversationId,
  selectedFile,
  onSelectFile,
  railPanelRef,
  fileWidthPx,
  onFileWidthChange,
  onOpenChange,
  centerSlot,
}: RightRailProps) {
  const lastReportedOpenRef = useRef(true);
  /** Latest selectedFile, read inside onResize without re-binding. */
  const selectedFileRef = useRef(selectedFile);
  selectedFileRef.current = selectedFile;
  /** Latest persisted file width, read inside the mode effect. */
  const fileWidthRef = useRef(fileWidthPx);
  fileWidthRef.current = fileWidthPx;
  const inFileMode = selectedFile !== null;

  // Snap rail width on mode transitions:
  //   workspace → file: resize to persisted file width (or auto-widen).
  //   file → workspace: resize back to the locked workspace width.
  useEffect(() => {
    const handle = railPanelRef.current;
    if (!handle) return;
    if (selectedFile !== null) {
      const target =
        fileWidthRef.current < FILE_AUTO_WIDEN_THRESHOLD_PX
          ? FILE_AUTO_WIDEN_PX
          : fileWidthRef.current;
      handle.resize(`${target}px`);
    } else {
      handle.resize(`${WORKSPACE_WIDTH_PX}px`);
    }
  }, [selectedFile, railPanelRef]);

  const maxRailPx = `${Math.max(
    FILE_AUTO_WIDEN_PX,
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
      <ResizableHandle
        disabled={!inFileMode}
        className={
          // Hide the divider line while in workspace mode so the rail looks
          // like the original flush-edge sidebar. The handle div itself stays
          // in the tree (the panel group needs it) but is non-interactive
          // and visually transparent.
          inFileMode
            ? undefined
            : "bg-transparent! cursor-default after:hidden"
        }
      />
      <ResizablePanel
        panelRef={railPanelRef}
        defaultSize={`${WORKSPACE_WIDTH_PX}px`}
        minSize={`${RAIL_MIN_PX}px`}
        maxSize={maxRailPx}
        collapsible
        collapsedSize={0}
        groupResizeBehavior="preserve-pixel-size"
        onResize={(panelSize: PanelSize) => {
          const px = panelSize.inPixels;
          // Persist only while in file mode — programmatic snaps back to the
          // workspace width must never overwrite the user's saved file width.
          if (px > 0 && selectedFileRef.current !== null) {
            onFileWidthChange(Math.round(px));
          }
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

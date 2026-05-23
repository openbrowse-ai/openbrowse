import { useEffect, useRef, useState } from "react";
import type { PanelImperativeHandle, PanelSize } from "react-resizable-panels";
import { AnimatePresence, motion } from "motion/react";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { animatePanelResize } from "@/lib/animate-panel-resize";
import { CoworkPanel } from "./CoworkPanel";
import { FileViewerPanel } from "./FileViewerPanel";

interface RightRailProps {
  conversationId: string;
  /** Selected file path RELATIVE to the workspace root (e.g. `notes.csv`). */
  selectedFile: string | null;
  onSelectFile: (file: string | null) => void;
  /**
   * Whether the rail is open (visible) at all. Driven by the parent's
   * side-panel toggle button. Toggling animates the rail width to/from 0.
   */
  isOpen: boolean;
  /** Persisted file-viewer width (pixels). */
  fileWidthPx: number;
  onFileWidthChange: (px: number) => void;
  /** Center pane (chat) — rendered as the left panel of the resizable group. */
  centerSlot: React.ReactNode;
}

/** Fixed width for workspace mode. The user does not resize this. */
export const WORKSPACE_WIDTH_PX = 360;
/** Lower drag bound for file mode — user can't drag below this. */
export const FILE_MIN_PX = 320;
/** Soft minimum for file mode — auto-widen kicks in below this. */
export const FILE_AUTO_WIDEN_THRESHOLD_PX = 480;
/** Width used by auto-widen when the persisted width is below threshold. */
export const FILE_AUTO_WIDEN_PX = 560;
/** Animation duration for programmatic open/close and mode switches. */
const TWEEN_MS = 240;

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
 * Open/close (`isOpen`) and mode transitions both ANIMATE — react-resizable-
 * panels' `resize()` is instant by default, so we tween it ourselves via
 * `animatePanelResize`. Width persistence is suppressed during animation.
 */
export function RightRail({
  conversationId,
  selectedFile,
  onSelectFile,
  isOpen,
  fileWidthPx,
  onFileWidthChange,
  centerSlot,
}: RightRailProps) {
  /** Imperative handle on the rail panel — internal only. */
  const railPanelRef = useRef<PanelImperativeHandle | null>(null);
  /** Latest selectedFile, read inside onResize without re-binding. */
  const selectedFileRef = useRef(selectedFile);
  selectedFileRef.current = selectedFile;
  /** Latest persisted file width, read inside the mode/open effect. */
  const fileWidthRef = useRef(fileWidthPx);
  fileWidthRef.current = fileWidthPx;
  /** Set to true while a programmatic tween is in flight; suppresses persist. */
  const animatingRef = useRef(false);
  /** Cancel handle for the currently running tween. */
  const cancelTweenRef = useRef<(() => void) | null>(null);
  const hasInitializedRef = useRef(false);

  const inFileMode = selectedFile !== null;

  /**
   * Initial defaultSize for the rail panel, captured ONCE at mount. We
   * intentionally do not recompute this on subsequent renders — the
   * library only honors `defaultSize` for the first layout pass, and we
   * drive subsequent size changes through the imperative handle below.
   * Using `useState` with an initializer pins the value to mount time.
   */
  const [initialRailSize] = useState<number>(() => {
    if (!isOpen) return 0;
    
    // We compute the initial size as a raw percentage rather than a pixel string
    // (e.g. "360px"). When `react-resizable-panels` parses a pixel string on mount,
    // it must divide by its own container width. If the flex container hasn't
    // expanded to its true width yet (common when mounting into a new route/view),
    // the division yields a tiny percentage (like 1.6%) and permanently locks
    // the panel to a sliver. Providing a percentage bypasses the math bug.
    const getTargetPx = () => {
      if (selectedFile !== null) {
        return fileWidthPx < FILE_AUTO_WIDEN_THRESHOLD_PX
          ? FILE_AUTO_WIDEN_PX
          : fileWidthPx;
      }
      return WORKSPACE_WIDTH_PX;
    };
    
    // Fallback innerWidth if SSR or not available
    const vw = typeof window !== "undefined" ? window.innerWidth : 1280;
    // Account for the 260px left sidebar to estimate our container width
    const estimatedContainerWidth = Math.max(800, vw - 260);
    const targetPx = getTargetPx();
    
    // Return percentage (0..100)
    return (targetPx / estimatedContainerWidth) * 100;
  });

  // Drive the rail width from `isOpen` + `selectedFile`. Three target sizes:
  //   isOpen=false → 0
  //   isOpen=true && file mode → fileWidth (auto-widened if narrow)
  //   isOpen=true && workspace mode → WORKSPACE_WIDTH_PX
  useEffect(() => {
    const handle = railPanelRef.current;
    if (!handle) return;
    
    if (!hasInitializedRef.current) {
      // First run after mount: trust the panel's `defaultSize`.
      // By using a percentage for defaultSize, we bypass the library's
      // pixel-conversion mount bug. The panel snaps instantly to the right
      // width without an unwanted tween animation.
      hasInitializedRef.current = true;
      return;
    }
    
    const target = !isOpen
      ? 0
      : selectedFile !== null
        ? fileWidthRef.current < FILE_AUTO_WIDEN_THRESHOLD_PX
          ? FILE_AUTO_WIDEN_PX
          : fileWidthRef.current
        : WORKSPACE_WIDTH_PX;
        
    const fromPx = handle.getSize?.()?.inPixels ?? 0;
    if (Math.abs(fromPx - target) < 0.5) return;
    
    cancelTweenRef.current?.();
    cancelTweenRef.current = animatePanelResize(handle, fromPx, target, {
      durationMs: TWEEN_MS,
      flagRef: animatingRef,
    });
  }, [isOpen, selectedFile]);

  useEffect(() => {
    return () => {
      cancelTweenRef.current?.();
    };
  }, []);

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
    <ResizablePanelGroup 
      orientation="horizontal" 
      className="flex-1 min-w-0"
    >
      <ResizablePanel
        minSize="400px"
        groupResizeBehavior="preserve-relative-size"
      >
        {centerSlot}
      </ResizablePanel>
      <ResizableHandle
        disabled={!inFileMode}
        className={
          // Hide the divider while in workspace mode so the rail looks like
          // the original flush-edge sidebar. The handle div stays in the
          // tree (the panel group needs it) but is non-interactive and
          // visually transparent.
          inFileMode
            ? undefined
            : "bg-transparent! cursor-default after:hidden"
        }
      />
      <ResizablePanel
        panelRef={railPanelRef}
        defaultSize={initialRailSize}
        // In file mode the user can drag between FILE_MIN_PX and maxRailPx —
        // the library clamps without snapping. In workspace mode the handle
        // is disabled, but minSize must remain 0 so programmatic close-tweens
        // (resize → 0) aren't clamped.
        minSize={inFileMode ? `${FILE_MIN_PX}px` : "0px"}
        maxSize={maxRailPx}
        groupResizeBehavior="preserve-pixel-size"
        onResize={(panelSize: PanelSize) => {
          // Skip persistence while a programmatic tween is in flight —
          // intermediate frames would otherwise thrash localStorage and
          // potentially lock in a transient width.
          if (animatingRef.current) return;
          // Only persist while in file mode. Workspace mode width is fixed.
          if (
            panelSize.inPixels > 0 &&
            selectedFileRef.current !== null
          ) {
            onFileWidthChange(Math.round(panelSize.inPixels));
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

import { cn } from "@/lib/utils";
import { ChevronRightIcon } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";

interface StepGroupProps {
  /** Number of tool calls in this group — drives the "Completed N steps" label. */
  stepCount: number;
  /**
   * True while this group's work is still in flight (the trailing group of a
   * streaming message that hasn't produced its answer text yet). While active
   * the children render expanded and chrome-free so each tool row shows its own
   * live/pending UI. When this flips to false the group auto-folds into the
   * "Completed N steps" collapsible — mirroring Perplexity Comet.
   */
  isActive: boolean;
  children: ReactNode;
}

/**
 * Groups a run of tool-call (and interleaved reasoning) parts.
 *
 * - Active (tools running, no answer yet): renders children inline, expanded,
 *   no collapsible chrome — identical to the pre-grouping behavior.
 * - Inactive (answer text began / stream ended): auto-collapses into a
 *   "Completed N steps" header with a chevron. Click to re-expand; collapsed
 *   by default once folded.
 *
 * The auto-fold transition follows the same `isStreaming`-driven pattern as the
 * `Reasoning` component.
 */
export function StepGroup({ stepCount, isActive, children }: StepGroupProps) {
  // While active we render expanded+chrome-free. Once folded, the collapsible
  // starts closed and the user can toggle it open.
  const [open, setOpen] = useState(false);
  const wasActiveRef = useRef(isActive);

  useEffect(() => {
    if (isActive) {
      // (Re)entered the active phase — make sure we're not stuck open from a
      // previous fold (shouldn't normally happen, but keeps state coherent).
      wasActiveRef.current = true;
      setOpen(false);
    } else if (wasActiveRef.current) {
      // Just transitioned active -> folded: collapse by default.
      wasActiveRef.current = false;
      setOpen(false);
    }
  }, [isActive]);

  if (isActive) {
    // Live: render children exactly as they were before grouping.
    return <div className="flex w-full flex-col">{children}</div>;
  }

  const label = stepCount === 1 ? "Completed 1 step" : `Completed ${stepCount} steps`;

  return (
    <div className="my-0.5 w-full">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="group flex items-center gap-1.5 py-0.5 text-xs text-muted-foreground hover:text-foreground"
      >
        <span className="font-medium">{label}</span>
        <ChevronRightIcon
          className={cn(
            "size-3 shrink-0 transition-transform",
            open && "rotate-90",
          )}
        />
      </button>
      {open && (
        <div className="mt-1 ml-1 flex flex-col border-l-2 border-muted pl-3">
          {children}
        </div>
      )}
    </div>
  );
}

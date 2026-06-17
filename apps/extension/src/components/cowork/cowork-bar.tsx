import { useEffect, useRef, useState } from "react";
import { ChevronRight, ListChecks, Folder, Layers } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useFileSelection } from "@/lib/file-selection-context";
import { planSummary } from "./plan-summary";
import { TodoRow } from "./progress-card";
import { useConversationTodos } from "./use-conversation-todos";
import { useWorkspaceHasContent } from "./use-workspace-has-content";
import { WorkingFolderCard } from "./working-folder-card";
import { ContextCard } from "./context-card";

type Panel = "plan" | "files" | "context";

/**
 * Glanceable cowork bar for the chat composer. Tabs the plan/todos, the
 * Workspace files, and the Context onto a single strip so the side panel
 * doesn't need separate header controls.
 *
 * Strip: a chevron + dynamic label on the left reflecting the active tab
 * (`Plan · done/total`, `Workspace files`, or `Context`), then the three
 * tab buttons (checklist / folder / layers). Clicking a tab selects it and
 * expands the panel; clicking the active tab again, or clicking the strip
 * background, collapses. The Plan tab is selected by default. Exactly one
 * panel shows at a time; the expanded region animates its pixel height on
 * open, close, and tab switches (capped at 40vh with internal scroll so a
 * long list never crowds out the input). In-panel headers are suppressed
 * (`showHeader={false}`) since the strip label already names the panel.
 *
 * The bar is side-panel-only: it renders only when `showWorkspaceControls`
 * is set. The home view suppresses it entirely because its RightRail
 * already renders the Plan / Working folder / Context cards, so a second
 * surface above the composer would be redundant.
 *
 * Within the side panel, the bar is hidden until there's something to
 * show — i.e. the agent has written a plan (todoWrite) or the workspace
 * contains any file. Mount with `key={conversationId}` so open state
 * resets on conversation switch.
 */
export function CoworkBar({
  conversationId,
  showWorkspaceControls = false,
}: {
  conversationId: string | null;
  showWorkspaceControls?: boolean;
}) {
  const todos = useConversationTodos(conversationId);
  const hasWorkspaceContent = useWorkspaceHasContent(
    showWorkspaceControls ? conversationId : null,
  );
  const onSelectFile = useFileSelection();
  // Tabbed model: `activePanel` is the selected tab (Plan is the default);
  // `open` is whether the expanded region is showing. Clicking a tab selects
  // it and expands; clicking the bar background toggles `open`.
  const [open, setOpen] = useState(false);
  const [activePanel, setActivePanel] = useState<Panel>("plan");

  const hasPlan = todos.length > 0;
  // Effective panel to display. When the selected tab is Plan but there are
  // no todos yet, fall back to Files for display (the Plan tab is hidden in
  // that state) — computed, not stored, so it never fights a user selection:
  // once todos appear the Plan tab returns and selecting it sticks.
  const shownPanel: Panel =
    activePanel === "plan" && !hasPlan && showWorkspaceControls
      ? "files"
      : activePanel;
  // Animate the expanded region's height in pixels. `fr`/`auto` heights
  // don't transition when the *content* changes (only on explicit
  // open/close keyframes), so we drive an explicit `height` measured from
  // the content — this animates open, close, and panel swaps uniformly.
  // The measured height already reflects the inner `max-h-[40vh]` cap, so
  // tall panels clamp.
  //
  // Measured post-paint (`useEffect`) so opening animates from the painted
  // 0-height up to the measured height. The `[shownPanel, open]` deps force
  // a fresh measurement when the panel or open-state changes; live content
  // growth while already open is handled by the ResizeObserver, not the
  // effect re-running.
  const contentRef = useRef<HTMLDivElement>(null);
  const [contentHeight, setContentHeight] = useState(0);
  useEffect(() => {
    const el = contentRef.current;
    if (!el) return;
    const measure = () => setContentHeight(el.scrollHeight);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [shownPanel, open]);

  const visible =
    Boolean(conversationId) &&
    showWorkspaceControls &&
    (hasPlan || hasWorkspaceContent);

  // Escape collapses the expanded region.
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open]);

  if (!visible || !conversationId) return null;

  const { done, total, live } = planSummary(todos);

  // Select a tab and expand. Clicking the already-active tab collapses.
  const selectTab = (panel: Panel) => {
    setActivePanel(panel);
    setOpen((prev) => (shownPanel === panel ? !prev : true));
  };

  const handleSelectFile = (file: string | null) => {
    if (file !== null) {
      onSelectFile?.(file);
      setOpen(false);
    }
  };

  const stripLabel =
    shownPanel === "plan"
      ? `Plan · ${done}/${total}`
      : shownPanel === "files"
        ? "Workspace files"
        : "Context";

  const tabClass = (panel: Panel) =>
    `rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground ${
      open && shownPanel === panel ? "bg-accent text-foreground" : ""
    }`;

  return (
    <div className="mb-1.5 overflow-hidden rounded-md border border-border/60 bg-accent/50">
      {/* Resting strip: clicking the background toggles the panel; the tab
          buttons select + expand a specific panel. The label reflects the
          active tab. */}
      <div className="flex items-center gap-2 px-2 py-1.5">
        <button
          type="button"
          onClick={() => setOpen((prev) => !prev)}
          aria-label={open ? "Collapse panel" : "Expand panel"}
          aria-expanded={open}
          className="group flex min-w-0 flex-1 items-center gap-2 text-left"
        >
          <ChevronRight
            aria-hidden
            className={`size-3 shrink-0 text-muted-foreground transition-transform duration-200 ${open ? "rotate-90" : ""}`}
          />
          <span className="shrink-0 text-xs font-medium">{stripLabel}</span>
          {shownPanel === "plan" && live && !open && (
            <span
              title={live}
              className="min-w-0 truncate text-xs text-muted-foreground"
            >
              {live}
            </span>
          )}
        </button>

        {hasPlan && (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={() => selectTab("plan")}
                aria-label="Plan"
                aria-expanded={open && shownPanel === "plan"}
                className={tabClass("plan")}
              >
                <ListChecks className="size-3.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent>Plan</TooltipContent>
          </Tooltip>
        )}

        {showWorkspaceControls && (
          <>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={() => selectTab("files")}
                  aria-label="Workspace files"
                  aria-expanded={open && shownPanel === "files"}
                  className={tabClass("files")}
                >
                  <Folder className="size-3.5" />
                </button>
              </TooltipTrigger>
              <TooltipContent>Workspace files</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={() => selectTab("context")}
                  aria-label="Context"
                  aria-expanded={open && shownPanel === "context"}
                  className={tabClass("context")}
                >
                  <Layers className="size-3.5" />
                </button>
              </TooltipTrigger>
              <TooltipContent>Context</TooltipContent>
            </Tooltip>
          </>
        )}
      </div>

      {/* Expanded region — an explicit pixel `height` transition animates
          open / close / panel-swap (the content height changes while it
          stays open). The height is measured from the content. Content is
          mounted only while open, so the panels' polling hooks (todos,
          Context tabs) don't run while the bar is collapsed. */}
      <div
        className="overflow-hidden transition-[height] duration-200 ease-out"
        style={{ height: open ? contentHeight : 0 }}
      >
        <div ref={contentRef}>
          {open && shownPanel === "plan" && (
            <ul className="max-h-[40vh] space-y-0.5 overflow-y-auto border-t border-border/60 bg-background px-1.5 py-1">
              {todos.map((todo) => (
                <li key={todo.id}>
                  <TodoRow todo={todo} />
                </li>
              ))}
            </ul>
          )}
          {open && shownPanel === "files" && (
            <div className="max-h-[40vh] overflow-y-auto border-t border-border/60 bg-background">
              <WorkingFolderCard
                conversationId={conversationId}
                onSelectFile={handleSelectFile}
                collapsible={false}
                showHeader={false}
              />
            </div>
          )}
          {open && shownPanel === "context" && (
            <div className="max-h-[40vh] overflow-y-auto border-t border-border/60 bg-background">
              <ContextCard
                conversationId={conversationId}
                onSelectFile={handleSelectFile}
                collapsible={false}
                showHeader={false}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

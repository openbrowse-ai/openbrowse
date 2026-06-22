import { Globe, ListChecks } from "lucide-react";
import { useEffect, useMemo, useRef } from "react";
import { Kbd } from "@/components/ui/kbd";
import type { ProposePlanInput } from "@/lib/agent/tools/propose-plan";

interface PlanApprovalCardProps {
  toolCallId: string;
  /**
   * The proposePlan tool's input as parsed by the SDK. Wrapped in
   * `Partial<>` because the SDK may surface `part.input` before the
   * model has emitted every required field — fields are filled in
   * progressively as the JSON streams. The field-level defaults below
   * (`?? []`, `?? ""`) defend against that.
   */
  args: Partial<ProposePlanInput>;
  approvalId: string;
  onApprove: (id: string) => void;
  onDeny: (id: string) => void;
  /**
   * Where the card is mounted. `inline` is the original mid-message
   * placement (left-indented to fit within the assistant message bubble
   * structure). `composer` mounts the card in place of the chat
   * composer at the bottom of the chat — drops the left indent and
   * auto-focuses Approve so plain Enter advances the user.
   */
  variant?: "inline" | "composer";
}

/**
 * Render a hostname-only label for a site URL. Strips protocol, drops
 * trailing slash, hides empty paths. `https://www.ycombinator.com/x` →
 * `www.ycombinator.com/x`. Falls back to the raw input when parsing
 * fails (e.g. the model emitted a bare hostname).
 */
function shortenHost(url: string): string {
  try {
    const u = new URL(url);
    const path = u.pathname && u.pathname !== "/" ? u.pathname : "";
    return `${u.host}${path}`;
  } catch {
    return url;
  }
}

export function PlanApprovalCard({
  args,
  approvalId,
  onApprove,
  onDeny,
  variant = "inline",
}: PlanApprovalCardProps) {
  const sites = args.sites ?? [];
  const todos = args.todos ?? [];
  const goal = args.goal ?? "";
  const allowNetwork = args.allowNetwork === true;
  const approveButtonRef = useRef<HTMLButtonElement | null>(null);

  const displaySites = useMemo(() => sites.map(shortenHost), [sites]);

  // Keyboard shortcuts:
  //   - plain Enter         → Approve (primary)
  //   - Cmd/Ctrl + Enter    → Make changes (secondary)
  //
  // Both work as global accelerators while the card is mounted, so the
  // user doesn't have to ensure the Approve button retains focus. We
  // gate plain Enter on:
  //   - "no editable element is focused" so the user typing into a
  //     search/input elsewhere (rare on this surface, but defensive)
  //     doesn't accidentally approve.
  //   - "no button element is focused" so the user can Tab to the
  //     "Make changes" button and press Enter to deny — without our
  //     handler racing the button's native click. Without this guard,
  //     pressing Enter on the focused Make changes button would fire
  //     BOTH the button's onClick (deny) AND our handler (approve).
  //
  // Cmd+Enter has no such gate — it's a deliberate two-key combo.
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key !== "Enter") return;
      if (e.metaKey || e.ctrlKey) {
        e.preventDefault();
        onDeny(approvalId);
        return;
      }
      if (e.shiftKey || e.altKey) return;
      const active = document.activeElement;
      const shouldSkip =
        active instanceof HTMLInputElement ||
        active instanceof HTMLTextAreaElement ||
        active instanceof HTMLButtonElement ||
        (active instanceof HTMLElement && active.isContentEditable);
      if (shouldSkip) return;
      e.preventDefault();
      onApprove(approvalId);
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [approvalId, onApprove, onDeny]);

  // Auto-focus Approve in the composer variant so plain Enter (not just
  // Cmd/Ctrl+Enter) commits, and so screen readers land on the action
  // when the card replaces the composer.
  useEffect(() => {
    if (variant === "composer") {
      approveButtonRef.current?.focus();
    }
  }, [variant]);

  const wrapperClass = "flex flex-col w-full";
  const cardClass =
    variant === "composer"
      ? "rounded-lg border border-border bg-card overflow-hidden"
      : "ml-3 mt-1 mb-1 rounded-lg border border-border bg-card overflow-hidden";

  return (
    <div className={wrapperClass}>
      <div className={cardClass}>
        {/* Card header — gives the plan a clear identity without color
            coding the whole card as "warning." */}
        <div className="flex items-center gap-2 px-4 py-3 border-b border-border">
          <ListChecks className="size-4 shrink-0 text-foreground" />
          <span className="text-sm font-medium">Plan</span>
        </div>

        {goal && (
          <div className="px-4 py-3 border-b border-border">
            <div className="text-xs text-muted-foreground mb-1">Goal</div>
            <div className="text-sm leading-relaxed">{goal}</div>
          </div>
        )}

        {displaySites.length > 0 && (
          <div className="px-4 py-3 border-b border-border">
            <div className="text-xs text-muted-foreground mb-1.5">
              Allow actions on these sites
            </div>
            <ul className="space-y-1">
              {displaySites.map((host, i) => (
                <li
                  key={i}
                  className="flex items-center gap-2 text-sm"
                >
                  <Globe className="size-3.5 shrink-0 text-muted-foreground" />
                  <span>{host}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {todos.length > 0 && (
          <div className="px-4 py-3 border-b border-border">
            <div className="text-xs text-muted-foreground mb-2">
              Approach to follow
            </div>
            <ol className="space-y-2">
              {todos.map((t, i) => (
                <li key={i} className="flex items-start gap-3">
                  <span className="flex size-5 shrink-0 items-center justify-center rounded-full border border-border text-[11px] text-muted-foreground mt-0.5">
                    {i + 1}
                  </span>
                  <span className="text-sm leading-relaxed">{t.content}</span>
                </li>
              ))}
            </ol>
          </div>
        )}

        {allowNetwork && (
          <div className="px-4 py-2 border-b border-border text-xs text-muted-foreground">
            Plan permits external network calls via Python.
          </div>
        )}

        {/* Action region. Buttons are full-width and stacked: Approve is
            primary (filled), Make changes is secondary (outlined).
            Approve is auto-focused in the composer variant, so plain
            Enter approves; Cmd/Ctrl+Enter is the accelerator for Make
            changes (the harder-to-reach secondary action). */}
        <div className="flex flex-col gap-1.5 px-4 py-3">
          <button
            ref={approveButtonRef}
            type="button"
            data-action=""
            onClick={() => onApprove(approvalId)}
            className="flex items-center justify-between gap-2 w-full rounded-md px-4 py-2.5 text-sm font-medium bg-primary text-primary-foreground hover:opacity-90 transition-opacity"
          >
            <span>Approve plan</span>
            <Kbd>⏎</Kbd>
          </button>
          <button
            type="button"
            onClick={() => onDeny(approvalId)}
            className="flex items-center justify-between gap-2 w-full rounded-md px-4 py-2.5 text-sm font-medium border border-border bg-card hover:bg-accent transition-colors"
          >
            <span>Make changes</span>
            <Kbd>⌘⏎</Kbd>
          </button>
        </div>
      </div>

      <p className="text-xs text-muted-foreground px-1 mt-2 leading-relaxed">
        The agent will use the sites listed. If it needs to touch a different site, you'll be asked — and that approval extends the plan for the rest of this conversation.
      </p>
    </div>
  );
}

export { shortenHost };

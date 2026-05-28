import { Check, ShieldCheck, X } from "lucide-react";
import { useEffect, useState } from "react";
import { getToolPreview } from "./tool-previews";
import { DefaultPreview } from "./tool-previews/primitives";
import { TabBadge } from "./ToolCallBlock";

interface ToolApprovalBlockProps {
  toolName: string;
  toolCallId: string;
  args: Record<string, unknown>;
  approvalId: string;
  siteOrigin?: string;
  onApprove: (id: string) => void;
  onDeny: (id: string) => void;
  /**
   * Persist "Always allow on <site>" for this tool/origin pair.
   *
   * Returns a `Promise` because the implementation writes to
   * `chrome.storage.local`, which is async. Callers MUST await this
   * promise before resuming the agent — otherwise the next tool call's
   * `needsApproval` callback may read the pre-write allowlist and
   * prompt the user again. The race manifested most reliably on
   * home.html where back-to-back `executeOnPage` calls hit the
   * `needsApproval` check before the storage write landed.
   */
  onAlwaysAllow?: (toolName: string, origin: string) => Promise<void> | void;
}

/**
 * Extracted handler for the "Always allow on <site>" button click so
 * it's exercisable in unit tests without React Testing Library.
 *
 * Contract: ALWAYS approve the in-flight call after attempting the
 * persist, even on persist failure. The user's intent (approve this
 * call) is independent of the cross-call grant; failing the grant
 * silently is preferable to leaving the agent stuck.
 *
 * Order is load-bearing: the persist must complete before approve so
 * the next tool call's `needsApproval` reads the new allowlist. See
 * the comment in the component body for context.
 *
 * Exported for unit tests.
 */
export async function handleAlwaysAllow(args: {
  toolName: string;
  origin: string;
  approvalId: string;
  onAlwaysAllow: (toolName: string, origin: string) => Promise<void> | void;
  onApprove: (id: string) => void;
  /** Test seam for capturing console warnings on persist failure. */
  warn?: (...parts: unknown[]) => void;
}): Promise<void> {
  try {
    await args.onAlwaysAllow(args.toolName, args.origin);
  } catch (err) {
    (args.warn ?? console.warn)(
      "[approval] failed to persist 'always allow' grant; approving anyway",
      err,
    );
  } finally {
    args.onApprove(args.approvalId);
  }
}

export function ToolApprovalBlock({ toolName, toolCallId, args, approvalId, siteOrigin, onApprove, onDeny, onAlwaysAllow }: ToolApprovalBlockProps) {
  const customPreview = getToolPreview(toolName);
  // True between the user clicking "Always allow on <site>" and the
  // storage write resolving. Disables both approval buttons during the
  // window so a quick second click can't bypass the await.
  const [persistingAllowlist, setPersistingAllowlist] = useState(false);

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        onApprove(approvalId);
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [approvalId, onApprove]);

  const displayOrigin = siteOrigin ? new URL(siteOrigin).hostname : undefined;

  return (
    <div className="flex flex-col w-full">
      <div className="flex items-center gap-1.5 py-0.5">
        <span className="size-1.5 rounded-full shrink-0 bg-amber-500 animate-pulse" />
        <span className="text-sm text-muted-foreground">
          {toolName} — waiting for approval
        </span>
        <TabBadge toolCallId={toolCallId} />
      </div>
      <div className="ml-3 mt-1 mb-1 rounded-md border border-amber-500/30 overflow-hidden text-xs font-mono">
        {customPreview ? customPreview(args) : <DefaultPreview args={args} />}
        <div className="flex flex-col gap-2 px-3 py-2 border-t border-amber-500/30 bg-amber-500/5">
          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={() => onDeny(approvalId)}
              disabled={persistingAllowlist}
              className="flex items-center gap-1.5 whitespace-nowrap rounded px-2.5 py-1.5 text-xs font-medium bg-muted text-muted-foreground hover:bg-accent hover:text-foreground transition-colors disabled:opacity-50 disabled:pointer-events-none"
            >
              <X className="size-3.5 shrink-0" />
              Deny
            </button>
            <button
              type="button"
              onClick={() => onApprove(approvalId)}
              disabled={persistingAllowlist}
              className="flex items-center gap-1.5 whitespace-nowrap rounded px-2.5 py-1.5 text-xs font-medium bg-emerald-600 text-white hover:bg-emerald-700 transition-colors disabled:opacity-60 disabled:pointer-events-none"
            >
              <Check className="size-3.5 shrink-0" />
              Allow
              <kbd className="ml-0.5 inline-flex items-center gap-0.5 rounded border border-white/20 bg-white/10 px-1 py-0.5 text-[10px] font-sans leading-none">
                <span>&#8984;</span><span>&#9166;</span>
              </kbd>
            </button>
          </div>
          {displayOrigin && onAlwaysAllow && (
            <button
              type="button"
              disabled={persistingAllowlist}
              onClick={async () => {
                if (persistingAllowlist) return;
                setPersistingAllowlist(true);
                // CRITICAL: persist must complete BEFORE approving.
                // The previous implementation fired both calls
                // synchronously, racing the chrome.storage.local
                // write against the next tool call's needsApproval
                // callback. See `handleAlwaysAllow` JSDoc.
                await handleAlwaysAllow({
                  toolName,
                  origin: siteOrigin!,
                  approvalId,
                  onAlwaysAllow,
                  onApprove,
                });
              }}
              className="flex items-center justify-center gap-1.5 w-full rounded px-2.5 py-1.5 text-xs font-medium bg-muted text-muted-foreground hover:bg-accent hover:text-foreground transition-colors disabled:opacity-60 disabled:pointer-events-none"
            >
              <ShieldCheck className="size-3.5 shrink-0" />
              Always allow on {displayOrigin}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

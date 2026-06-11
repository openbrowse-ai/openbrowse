import { Globe } from "lucide-react";

interface Props {
  args: Record<string, unknown>;
  result: unknown;
}

/**
 * Renders a navigation tool result. Two distinct tools share this renderer
 * (they collide on the `navigate` / `goBack` / `goForward` tool names):
 *
 *  1. CUA nav tools (`cua/nav-tools.ts`) return
 *     `{ imageDataUrl?, currentUrl?, noChange? }` — we show the landed URL and
 *     a post-navigation screenshot, matching the `computer` tool's rows.
 *
 *  2. The main agent's `navigate` tool (`tools/navigate.ts`) returns
 *     `{ navigated, url, tab?, snapshot?, refCount?, note?, error? }` — no
 *     screenshot. We show the landed URL plus any note/error. We deliberately
 *     do NOT dump the (multi-KB) `snapshot` text; refCount is summarized.
 */
export function NavigateResult({ args, result }: Props) {
  const obj = result as
    | {
        // CUA shape
        imageDataUrl?: string;
        currentUrl?: string;
        noChange?: boolean;
        // Main-agent shape
        navigated?: boolean;
        url?: string;
        tab?: string;
        snapshot?: string;
        refCount?: number;
        note?: string;
        error?: string;
      }
    | undefined;

  const imageUrl = obj?.imageDataUrl;
  const noChange = obj?.noChange === true;
  // CUA reports the landed URL as `currentUrl`; the main agent as `url`.
  const currentUrl = obj?.currentUrl ?? obj?.url;
  const note = obj?.note;
  const error = obj?.error;
  const refCount = typeof obj?.refCount === "number" ? obj.refCount : undefined;

  // The URL the model asked to navigate to (only present for `navigate`).
  const requestedUrl = typeof args.url === "string" ? args.url : undefined;
  const redirected =
    requestedUrl != null &&
    currentUrl != null &&
    !urlsEquivalent(requestedUrl, currentUrl);

  if (!imageUrl && !currentUrl && !noChange && !note && !error) return null;

  return (
    <div className="ml-3 mt-1 pl-3 pb-1 space-y-1">
      {currentUrl && (
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Globe className="size-3 shrink-0 opacity-70" />
          <span className="truncate font-mono" title={currentUrl}>
            {currentUrl}
          </span>
        </div>
      )}
      {redirected && (
        <div className="text-[11px] text-muted-foreground/60">
          Redirected from{" "}
          <span className="font-mono" title={requestedUrl}>
            {requestedUrl}
          </span>
        </div>
      )}
      {error ? (
        <div className="text-xs text-red-600/90 dark:text-red-400/90">
          {error}
        </div>
      ) : note ? (
        <div className="text-[11px] text-muted-foreground/60">{note}</div>
      ) : null}
      {noChange ? (
        <div className="text-xs text-muted-foreground/60">No change</div>
      ) : (
        imageUrl && (
          <div className="relative inline-block">
            <img
              src={imageUrl}
              alt="Navigation screenshot"
              className="max-w-full h-auto max-h-[400px] rounded border border-border object-contain"
            />
          </div>
        )
      )}
      {!imageUrl && !note && !error && refCount !== undefined && (
        <div className="text-[11px] text-muted-foreground/60">
          {refCount} interactive element{refCount === 1 ? "" : "s"}
        </div>
      )}
    </div>
  );
}

/**
 * Loose URL equality for the "redirected" hint: ignores a trailing slash and
 * is tolerant of unparseable inputs (falls back to exact string compare).
 */
function urlsEquivalent(a: string, b: string): boolean {
  const norm = (s: string) => {
    try {
      const u = new URL(s);
      return `${u.origin}${u.pathname.replace(/\/$/, "")}${u.search}`;
    } catch {
      return s.replace(/\/$/, "");
    }
  };
  return norm(a) === norm(b);
}

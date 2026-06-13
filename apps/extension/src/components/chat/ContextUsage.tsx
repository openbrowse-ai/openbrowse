import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { chatDb } from "@/lib/chat-db";
import type { ConversationUsage } from "@/lib/types";
import { getProvider } from "@/registry/providers";
import { useEffect, useState } from "react";

const tokenFmt = new Intl.NumberFormat(undefined);
const costFmt = new Intl.NumberFormat(undefined, {
  style: "currency",
  currency: "USD",
});
const dateFmt = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

/** Grouped exact token count, e.g. 53731 -> "53,731". */
export function formatTokens(tokens: number): string {
  return tokenFmt.format(tokens);
}

/** Grouped exact count (e.g. message counts). Alias of the same number format. */
export function formatCount(count: number): string {
  return tokenFmt.format(count);
}

/** Whole-number percent of context window used, clamped to 0–100; 0 when window is unknown. */
export function usagePercentValue(
  totalTokens: number,
  contextWindow: number,
): number {
  if (!contextWindow || contextWindow <= 0) return 0;
  // totalTokens (input+output of the latest step) can exceed the input-only
  // contextWindow when output is large; clamp the ceiling at 100.
  return Math.min(100, Math.round((totalTokens / contextWindow) * 100));
}

/** Whole-number percent of context window used (clamped to 100); 0% when window is unknown. */
export function formatUsagePercent(
  totalTokens: number,
  contextWindow: number,
): string {
  return `${usagePercentValue(totalTokens, contextWindow)}%`;
}

/**
 * USD currency, e.g. 73.48 -> "$73.48". A positive cost that would round
 * to "$0.00" at cent precision is shown as "<$0.01" so a real (tiny) spend
 * never reads as free.
 */
export function formatCost(costUsd: number): string {
  if (costUsd > 0 && costUsd < 0.005) return "<$0.01";
  return costFmt.format(costUsd);
}

/** Localized date+time, e.g. "May 26, 2026, 6:23 PM". Empty string for falsy input. */
export function formatDateTime(ms: number): string {
  if (!ms) return "";
  return dateFmt.format(new Date(ms));
}

/**
 * Resolve human-readable provider and model display names from the
 * persisted qualified model id ("provider:model"). Falls back to the raw
 * segments when the id can't be matched against the registry (e.g. a model
 * that was removed from the catalog), so the popover never shows blanks.
 */
export function resolveModelNames(modelId: string): {
  providerName: string;
  modelName: string;
} {
  if (!modelId) return { providerName: "—", modelName: "—" };
  const [providerId, ...rest] = modelId.split(":");
  const actualModelId = rest.length > 0 ? rest.join(":") : modelId;
  const provider = rest.length > 0 ? getProvider(providerId) : undefined;
  const model = provider?.models.find((m) => m.id === actualModelId);
  return {
    providerName: provider?.name ?? providerId,
    modelName: model?.name ?? actualModelId,
  };
}

/**
 * Resolve a combined provider + model label across every model used in the
 * conversation. Falls back to the single latest `modelId` when the list is
 * empty (snapshots written before `modelIds` existed). Distinct provider
 * names are joined with ", "; model names are joined with ", " in first-seen
 * order, so a multi-model conversation reads e.g. "Claude Opus 4.8, GPT-4".
 */
export function resolveModelsLabel(
  modelIds: string[] | undefined,
  latestModelId: string,
): { providerLabel: string; modelLabel: string } {
  const ids =
    modelIds && modelIds.length > 0
      ? modelIds
      : latestModelId
        ? [latestModelId]
        : [];
  if (ids.length === 0) return { providerLabel: "—", modelLabel: "—" };

  const resolved = ids.map(resolveModelNames);
  const providers: string[] = [];
  for (const r of resolved) {
    if (!providers.includes(r.providerName)) providers.push(r.providerName);
  }
  return {
    providerLabel: providers.join(", "),
    modelLabel: resolved.map((r) => r.modelName).join(", "),
  };
}

/**
 * Circular progress ring (no label). The arc fills proportionally to
 * `percent` (0–100), starting at the top. Uses `currentColor` so it
 * inherits the trigger button's theme color. `className` controls the
 * rendered size (defaults to the home header's `size-4`).
 */
function ContextRing({
  percent,
  className = "size-4",
}: {
  percent: number;
  className?: string;
}) {
  const radius = 9;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference * (1 - Math.min(100, Math.max(0, percent)) / 100);
  return (
    <svg
      viewBox="0 0 24 24"
      className={`${className} -rotate-90`}
      fill="none"
      aria-hidden="true"
    >
      <circle
        cx="12"
        cy="12"
        r={radius}
        stroke="currentColor"
        strokeWidth="2.5"
        className="opacity-20"
      />
      <circle
        cx="12"
        cy="12"
        r={radius}
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeDasharray={circumference}
        strokeDashoffset={offset}
      />
    </svg>
  );
}

/** One label/value cell in the detail grid. */
function DetailCell({ label, value }: { label: string; value: string }) {
  return (
    <div className="space-y-0.5">
      <div className="text-muted-foreground">{label}</div>
      <div className="font-medium break-words">{value}</div>
    </div>
  );
}

/** Snapshot of the conversation fields the indicator displays. */
interface ConvSnapshot {
  usage: ConversationUsage;
  title: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
}

/**
 * Header context-usage indicator. Polls the conversation row every 1s
 * (mirroring CoworkPanel's ContextCard). The ring trigger shows a compact
 * Tokens / Usage% / Cost tooltip on hover and opens a detailed popover on
 * click. Renders nothing until usage exists.
 *
 * `compact` shrinks the trigger (smaller ring + tighter padding) to match
 * the side panel's denser header buttons; the home header uses the default.
 */
export function ContextUsage({
  conversationId,
  compact = false,
}: {
  conversationId: string;
  compact?: boolean;
}) {
  const [snapshot, setSnapshot] = useState<ConvSnapshot | null>(null);

  useEffect(() => {
    let mounted = true;
    async function refresh() {
      try {
        const [conv, messageCount] = await Promise.all([
          chatDb.getConversation(conversationId),
          chatDb.getMessageCount(conversationId),
        ]);
        if (!mounted) return;
        if (!conv?.usage) {
          setSnapshot(null);
          return;
        }
        setSnapshot({
          usage: conv.usage,
          title: conv.title,
          createdAt: conv.createdAt,
          updatedAt: conv.updatedAt,
          messageCount,
        });
      } catch (err) {
        // Transient DB error: keep the last-good snapshot rather than
        // blanking the indicator, and don't let the rejection bubble out
        // of the interval. The next tick retries.
        console.error("[context-usage] failed to read usage:", err);
      }
    }
    refresh();
    const interval = setInterval(refresh, 1000);
    return () => {
      mounted = false;
      clearInterval(interval);
    };
  }, [conversationId]);

  if (!snapshot) return null;

  const { usage, title, createdAt, updatedAt, messageCount } = snapshot;
  const showCost = usage.costUsd > 0;
  const { providerLabel, modelLabel } = resolveModelsLabel(
    usage.modelIds,
    usage.modelId,
  );

  return (
    <Popover>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <button
              type="button"
              className={`rounded ${compact ? "p-1" : "p-1.5"} text-muted-foreground hover:bg-accent hover:text-foreground`}
              aria-label="Context usage"
            >
              <ContextRing
                percent={usagePercentValue(usage.totalTokens, usage.contextWindow)}
                className={compact ? "size-3.5" : "size-4"}
              />
            </button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent align="end">
          <dl className="space-y-1">
            <div className="flex items-center justify-between gap-4">
              <dd className="order-1 font-medium">
                {formatTokens(usage.totalTokens)}
              </dd>
              <dt className="order-2 opacity-70">Tokens</dt>
            </div>
            <div className="flex items-center justify-between gap-4">
              <dd className="order-1 font-medium">
                {formatUsagePercent(usage.totalTokens, usage.contextWindow)}
              </dd>
              <dt className="order-2 opacity-70">Usage</dt>
            </div>
            {showCost && (
              <div className="flex items-center justify-between gap-4">
                <dd className="order-1 font-medium">
                  {formatCost(usage.costUsd)}
                </dd>
                <dt className="order-2 opacity-70">Cost</dt>
              </div>
            )}
          </dl>
        </TooltipContent>
      </Tooltip>
      <PopoverContent align="end" className="w-80 p-3">
        <div className="grid grid-cols-2 gap-x-4 gap-y-3 text-xs">
          <DetailCell label="Session" value={title || "Untitled"} />
          <DetailCell label="Messages" value={formatCount(messageCount)} />
          <DetailCell label="Provider" value={providerLabel} />
          <DetailCell label="Model" value={modelLabel} />
          <DetailCell
            label="Context Limit"
            value={formatTokens(usage.contextWindow)}
          />
          <DetailCell
            label="Total Tokens"
            value={formatTokens(usage.totalTokens)}
          />
          <DetailCell
            label="Usage"
            value={formatUsagePercent(usage.totalTokens, usage.contextWindow)}
          />
          <DetailCell
            label="Input Tokens"
            value={formatTokens(usage.inputTokens)}
          />
          <DetailCell
            label="Output Tokens"
            value={formatTokens(usage.outputTokens)}
          />
          <DetailCell label="Total Cost" value={formatCost(usage.costUsd)} />
          <DetailCell label="Session Created" value={formatDateTime(createdAt)} />
          <DetailCell label="Last Activity" value={formatDateTime(updatedAt)} />
        </div>
      </PopoverContent>
    </Popover>
  );
}

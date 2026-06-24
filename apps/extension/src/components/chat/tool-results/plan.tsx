import { Globe } from "lucide-react";
import type { ApprovedPlan } from "@/lib/types";
import { shortenHost } from "../PlanApprovalCard";

interface Props {
  args: Record<string, unknown>;
  result: unknown;
}

/**
 * Result card for a `proposePlan` run. Shown after the user clicks
 * "Approve plan" in {@link PlanApprovalCard} and the tool's `execute`
 * persisted the plan. Past-tense voice — this is a record of what was
 * approved (and any extensions accumulated since), not a request for
 * action.
 *
 * Reads `result.plan` (the canonical, persistence-truthful state with
 * normalized origins and any auto-extensions appended) for sites /
 * allowNetwork / extensions; falls back to `args` for fields that
 * don't live on the plan (currently just `todos`, which seed
 * `todoWrite` and aren't re-stored here).
 *
 * Visual language mirrors {@link PlanApprovalCard}'s post-redesign
 * neutral aesthetic — same section structure (goal, sites, todos,
 * network notice), same hostname-only site rendering with a small
 * Globe glyph, same numbered circles for todos. Differences from the
 * approval card:
 *   - No header (no need to label "Plan" — the parent ToolCallBlock's
 *     "Plan approved" pill provides identity).
 *   - No buttons.
 *   - When `plan.extensions` is non-empty, an "Extensions" section
 *     surfaces auto-extensions so the user can audit which off-plan
 *     calls they approved into the plan.
 */
export function PlanResult({ args, result }: Props) {
  const resultObj = result as
    | { approved?: boolean; plan?: ApprovedPlan }
    | undefined;
  const plan = resultObj?.plan;
  const argTodos = (args.todos as Array<{ content?: string }> | undefined) ?? [];

  // Defensive fallbacks — if the result didn't shape up as expected
  // (e.g., a heal injected an empty result), fall back to the proposal
  // args so the user still sees what was sent.
  const goal = plan?.goal ?? (args.goal as string | undefined) ?? "";
  const sites = plan?.sites ?? (args.sites as string[] | undefined) ?? [];
  const allowNetwork =
    plan?.allowNetwork ?? args.allowNetwork === true;
  const extensions = plan?.extensions ?? [];

  return (
    <div className="ml-3 mt-1 mb-1 rounded-lg border border-border overflow-hidden">
      {goal && (
        <div className="px-4 py-3 border-b border-border">
          <div className="text-xs text-muted-foreground mb-1">Goal</div>
          <div className="text-sm leading-relaxed">{goal}</div>
        </div>
      )}
      {sites.length > 0 && (
        <div className="px-4 py-3 border-b border-border">
          <div className="text-xs text-muted-foreground mb-1.5">Sites</div>
          <ul className="space-y-1">
            {sites.map((s, i) => (
              <li key={i} className="flex items-center gap-2 text-sm">
                <Globe className="size-3.5 shrink-0 text-muted-foreground" />
                <span>{shortenHost(s)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {argTodos.length > 0 && (
        <div className="px-4 py-3 border-b border-border">
          <div className="text-xs text-muted-foreground mb-2">Approach</div>
          <ol className="space-y-2">
            {argTodos.map((t, i) => (
              <li key={i} className="flex items-start gap-3">
                <span className="flex size-5 shrink-0 items-center justify-center rounded-full border border-border text-[11px] text-muted-foreground mt-0.5">
                  {i + 1}
                </span>
                <span className="text-sm leading-relaxed">{t.content ?? ""}</span>
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
      {extensions.length > 0 && (
        <div className="px-4 py-3">
          <div className="text-xs text-muted-foreground mb-1.5">Extensions</div>
          <ul className="space-y-1">
            {extensions.map((ext, i) => (
              <li
                key={i}
                className="flex items-center gap-2 text-sm text-muted-foreground"
              >
                {ext.kind === "site" ? (
                  <>
                    <Globe className="size-3.5 shrink-0" />
                    <span>{shortenHost(ext.site)}</span>
                  </>
                ) : (
                  <span>Network access permitted</span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

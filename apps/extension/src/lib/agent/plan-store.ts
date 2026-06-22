/**
 * Persistence helpers for `ApprovedPlan` on a conversation row. Backed by
 * `chatDb.updateConversation` (the same primitive that powers todos).
 *
 * Every method is a no-op when the conversation doesn't exist — the read
 * path returns `undefined`, the write paths exit silently. This mirrors
 * the `setTodos` no-op behavior in `agent-transport.ts` and keeps the
 * bench harness path safe (subagents may have null conversation ids).
 */

import { chatDb } from "@/lib/chat-db";
import type { ApprovedPlan } from "@/lib/types";

/** Read the conversation's plan. Returns `undefined` when absent. */
export async function getPlan(
  conversationId: string,
): Promise<ApprovedPlan | undefined> {
  const conv = await chatDb.getConversation(conversationId);
  return conv?.plan;
}

/** Replace the conversation's plan wholesale. */
export async function setPlan(
  conversationId: string,
  plan: ApprovedPlan,
): Promise<void> {
  const conv = await chatDb.getConversation(conversationId);
  if (!conv) return;
  await chatDb.updateConversation(conversationId, {
    plan,
    updatedAt: Date.now(),
  });
}

/**
 * Append a site to the plan's allowlist (option-C deviation handling).
 * No-op when the site is already in the plan. Normalizes input via
 * `URL().origin` so callers can pass either an origin or a full URL.
 */
export async function extendPlanWithSite(
  conversationId: string,
  site: string,
): Promise<void> {
  const conv = await chatDb.getConversation(conversationId);
  const plan = conv?.plan;
  if (!plan) return;

  let origin: string;
  try {
    origin = new URL(site).origin;
  } catch {
    // Not a valid URL — treat as already-normalized origin string.
    origin = site;
  }

  if (plan.sites.includes(origin)) return;

  const next: ApprovedPlan = {
    ...plan,
    sites: [...plan.sites, origin],
    extensions: [
      ...plan.extensions,
      { kind: "site", site: origin, extendedAt: Date.now() },
    ],
  };
  await chatDb.updateConversation(conversationId, {
    plan: next,
    updatedAt: Date.now(),
  });
}

/**
 * Flip `allowNetwork` from false to true (option-C deviation handling for
 * `executePython` with `allow_network: true`). No-op when already true.
 */
export async function flipPlanNetwork(conversationId: string): Promise<void> {
  const conv = await chatDb.getConversation(conversationId);
  const plan = conv?.plan;
  if (!plan) return;
  if (plan.allowNetwork) return;

  const next: ApprovedPlan = {
    ...plan,
    allowNetwork: true,
    extensions: [
      ...plan.extensions,
      { kind: "network", extendedAt: Date.now() },
    ],
  };
  await chatDb.updateConversation(conversationId, {
    plan: next,
    updatedAt: Date.now(),
  });
}

/**
 * Pure decision: given a Plan-mode call's properties, what (if anything)
 * should be extended on the plan? Extracted as a pure function so it's
 * testable without stubbing IDB or the agent transport. The caller is
 * responsible for actually applying the result via `extendPlanWithSite`
 * or `flipPlanNetwork`.
 *
 * Returns:
 *   - { kind: "none" } — call is in-plan or unrelated
 *   - { kind: "site"; origin } — append `origin` to plan.sites
 *   - { kind: "network" } — flip plan.allowNetwork to true
 */
export type PlanExtensionDecision =
  | { kind: "none" }
  | { kind: "site"; origin: string }
  | { kind: "network" };

export function planExtensionForCall(args: {
  toolKey: string;
  inputAllowNetwork?: boolean;
  targetOrigin?: string;
  plan: ApprovedPlan;
}): PlanExtensionDecision {
  const { toolKey, inputAllowNetwork, targetOrigin, plan } = args;

  if (toolKey === "executePython") {
    if (inputAllowNetwork === true && !plan.allowNetwork) {
      return { kind: "network" };
    }
    return { kind: "none" };
  }

  // Tab-targeted tools: extend if the resolved origin is not in plan.sites.
  if (targetOrigin && !plan.sites.includes(targetOrigin)) {
    return { kind: "site", origin: targetOrigin };
  }
  return { kind: "none" };
}

/**
 * Registry of available subagent definitions.
 *
 * Built-ins are hard-coded in `built-ins/*.ts` and registered in
 * `BUILT_IN_AGENTS` below. User-defined markdown agents (deferred to a
 * later phase) will be merged on top via a future `loadUserAgents()`.
 *
 * Lookup order is built-in first; if/when user agents land, user agents
 * with the same slug as a built-in will be ignored (built-in wins) to
 * avoid users accidentally shadowing the trusted defaults.
 */

import { cuaAgent } from "./built-ins/cua";
import { exploreAgent } from "./built-ins/explore";
import { generalAgent } from "./built-ins/general";
import type { AgentDefinition } from "./types";

/** Hard-coded built-in agents. Order is the display order in the UI. */
const BUILT_IN_AGENTS: readonly AgentDefinition[] = Object.freeze([
  exploreAgent,
  generalAgent,
  cuaAgent,
]);

/** All currently registered agents. */
export function listAgents(): AgentDefinition[] {
  return [...BUILT_IN_AGENTS];
}

/** Look up a single agent by slug. */
export function getAgent(slug: string): AgentDefinition | undefined {
  return BUILT_IN_AGENTS.find((a) => a.slug === slug);
}

/**
 * Wire-shape definitions for the SW agent-host ↔ renderer Port protocol.
 *
 * Every payload sent over an `agent-run:<conversationId>` Port carries a
 * discriminator under `type`. Renderer-side `RemoteChatTransport` and
 * SW-side `port-router` use these guards to dispatch.
 *
 * Naming convention: every message type starts with `AGENT_RUN_` so we
 * can prefix-match on the discriminator and so a casual reader of the
 * runtime-message bus can recognize the channel at a glance.
 */

import type { UIMessageChunk } from "ai";
import type { AgentUIMessage } from "@/lib/agent/message-types";

/** Surface that initiated the run; used for diagnostics and notify-routing. */
export type RunOrigin = "sidepanel" | "home" | "newtab" | "popup";

export const AGENT_RUN = {
  /** renderer → SW: start a new run for `conversationId` */
  START: "AGENT_RUN_START",
  /** renderer → SW: abort the in-flight run */
  STOP: "AGENT_RUN_STOP",
  /** renderer → SW: route a tool-approval response into the live loop */
  APPROVE: "AGENT_RUN_APPROVE",
  /** renderer → SW: regenerate the last assistant turn */
  REGEN: "AGENT_RUN_REGEN",

  /** SW → renderer: acknowledgement after a port attaches; reports whether a run is already live */
  ACK: "AGENT_RUN_ACK",
  /** SW → renderer: one UIMessageChunk emitted by the agent stream */
  CHUNK: "AGENT_RUN_CHUNK",
  /** SW → renderer: the run reached a terminal state cleanly */
  DONE: "AGENT_RUN_DONE",
  /** SW → renderer: the run errored; payload carries the message */
  ERROR: "AGENT_RUN_ERROR",
} as const;

export type AgentRunType = (typeof AGENT_RUN)[keyof typeof AGENT_RUN];

// -- renderer → SW -----------------------------------------------------------

export interface AgentRunStartPayload {
  type: typeof AGENT_RUN.START;
  conversationId: string;
  /**
   * Input messages from the renderer's `Chat` instance (already
   * `validateUIMessages`-checked there). The SW transport re-validates as
   * a defence-in-depth step.
   */
  messages: AgentUIMessage[];
  /**
   * Surface that initiated. Diagnostic; the SW does not gate on this.
   */
  origin: RunOrigin;
  /**
   * Snapshot of the settings/transport configuration the SW needs to
   * reconstruct `createAgentTransport`. The renderer is the source of
   * truth for "which model/space/thinking-config/headless policy is in
   * effect right now"; once the snapshot crosses the port boundary the
   * SW owns the run's lifetime independently of the renderer.
   *
   * Shape is intentionally `unknown` here to keep `messages.ts` free of
   * runtime dependencies; `port-router` / `run.ts` import the concrete
   * settings type from `@/lib/storage` and `@/lib/agent/agent-transport`.
   */
  settingsSnapshot?: unknown;
}

export interface AgentRunStopPayload {
  type: typeof AGENT_RUN.STOP;
  conversationId: string;
}

/** Tool approval / denial round-tripped from the renderer UI. */
export interface AgentRunApprovePayload {
  type: typeof AGENT_RUN.APPROVE;
  conversationId: string;
  approval: {
    id: string;
    approved: boolean;
    reason?: string;
  };
}

export interface AgentRunRegenPayload {
  type: typeof AGENT_RUN.REGEN;
  conversationId: string;
  /** Optional id of the assistant message to regenerate; defaults to last. */
  assistantMessageId?: string;
  settingsSnapshot?: unknown;
}

// -- SW → renderer -----------------------------------------------------------

export interface AgentRunAckPayload {
  type: typeof AGENT_RUN.ACK;
  conversationId: string;
  /** True if a run was already live for this conversation when the port attached. */
  hasActiveRun: boolean;
}

export interface AgentRunChunkPayload {
  type: typeof AGENT_RUN.CHUNK;
  conversationId: string;
  chunk: UIMessageChunk;
}

export interface AgentRunDonePayload {
  type: typeof AGENT_RUN.DONE;
  conversationId: string;
}

export interface AgentRunErrorPayload {
  type: typeof AGENT_RUN.ERROR;
  conversationId: string;
  message: string;
}

// -- discriminated union + guards --------------------------------------------

export type AgentRunMessage =
  | AgentRunStartPayload
  | AgentRunStopPayload
  | AgentRunApprovePayload
  | AgentRunRegenPayload
  | AgentRunAckPayload
  | AgentRunChunkPayload
  | AgentRunDonePayload
  | AgentRunErrorPayload;

function isObject(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null;
}

function hasStringField(x: Record<string, unknown>, key: string): boolean {
  return typeof x[key] === "string";
}

export function isAgentRunStartPayload(x: unknown): x is AgentRunStartPayload {
  // Validate the full shape. The renderer always supplies `messages`
  // (a `UIMessage` array, possibly empty) and `origin` (a string from
  // the `RunOrigin` union). Reject malformed IPC payloads at the
  // boundary so the SW host can rely on the type assertion downstream.
  return (
    isObject(x) &&
    x.type === AGENT_RUN.START &&
    hasStringField(x, "conversationId") &&
    Array.isArray(x.messages) &&
    hasStringField(x, "origin")
  );
}

export function isAgentRunStopPayload(x: unknown): x is AgentRunStopPayload {
  return (
    isObject(x) &&
    x.type === AGENT_RUN.STOP &&
    hasStringField(x, "conversationId")
  );
}

export function isAgentRunApprovePayload(
  x: unknown,
): x is AgentRunApprovePayload {
  return (
    isObject(x) &&
    x.type === AGENT_RUN.APPROVE &&
    hasStringField(x, "conversationId") &&
    isObject(x.approval)
  );
}

export function isAgentRunRegenPayload(
  x: unknown,
): x is AgentRunRegenPayload {
  return (
    isObject(x) &&
    x.type === AGENT_RUN.REGEN &&
    hasStringField(x, "conversationId")
  );
}

export function isAgentRunAckPayload(x: unknown): x is AgentRunAckPayload {
  return (
    isObject(x) &&
    x.type === AGENT_RUN.ACK &&
    hasStringField(x, "conversationId") &&
    typeof x.hasActiveRun === "boolean"
  );
}

export function isAgentRunChunkPayload(
  x: unknown,
): x is AgentRunChunkPayload {
  return (
    isObject(x) &&
    x.type === AGENT_RUN.CHUNK &&
    hasStringField(x, "conversationId") &&
    "chunk" in x
  );
}

export function isAgentRunDonePayload(x: unknown): x is AgentRunDonePayload {
  return (
    isObject(x) &&
    x.type === AGENT_RUN.DONE &&
    hasStringField(x, "conversationId")
  );
}

export function isAgentRunErrorPayload(
  x: unknown,
): x is AgentRunErrorPayload {
  return (
    isObject(x) &&
    x.type === AGENT_RUN.ERROR &&
    hasStringField(x, "conversationId") &&
    hasStringField(x, "message")
  );
}

/** Port-name prefix; full port name is `agent-run:<conversationId>`. */
export const AGENT_RUN_PORT_PREFIX = "agent-run:";

/** Extract the conversationId from a port name, or null if mismatched. */
export function parseAgentRunPortName(name: string): string | null {
  if (!name.startsWith(AGENT_RUN_PORT_PREFIX)) return null;
  const id = name.slice(AGENT_RUN_PORT_PREFIX.length);
  return id.length > 0 ? id : null;
}

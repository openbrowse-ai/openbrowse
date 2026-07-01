export const PROTOCOL_VERSION = 1;

export interface HelloChallengeMessage {
  type: "hello-challenge";
  protocolVersion: 1;
  brokerVersion: string;
  publicKeyFingerprint: string;
  processInfo: { pid: number; executablePath: string; startedAt: number };
  nonce: string;
  /** Optional sha256 of the broker binary. Best-effort; advisory only. */
  binarySha256?: string;
}

export interface HelloResponseMessage {
  type: "hello-response";
  protocolVersion: 1;
  extensionVersion: string;
  capabilities: { tools: string[]; profile: string };
}

export interface HelloProofMessage {
  type: "hello-proof";
  signature: string;
  sessionId: string;
}

export interface HelloRejectMessage {
  type: "hello-reject";
  reason: "protocol_version_unsupported" | "session_already_active";
  brokerProtocolVersions: number[];
  brokerVersion: string;
}

export interface HostInfo {
  name: string;
  version: string;
}

export type RpcMethod =
  | "get_context"
  | "list_windows"
  | "list_spaces"
  | "read_page"
  // Phase 2:
  | "task"
  | "cancel_task"
  | "screenshot"
  | "open_url"
  // 2026-06-29 async dispatch:
  | "task_status"
  | "task_wait";

export interface RpcRequestMessage {
  type: "rpc";
  id: string;
  hostInfo: HostInfo;
  method: RpcMethod;
  params: unknown;
}

export interface RpcResultMessage {
  type: "rpc-result";
  id: string;
  result: unknown;
}

export interface RpcErrorMessage {
  type: "rpc-error";
  id: string;
  error: { code: string; message: string; data?: unknown };
}

/**
 * Streaming task progress event from extension → broker for an in-flight
 * `task` RPC. The broker forwards these to the originating MCP host as
 * progress notifications (MCP 2025-06-18 `notifications/progress`). Phase 2
 * emits one event per agent tool call.
 */
export interface TaskEventMessage {
  type: "task-event";
  /** The rpc.id of the originating `task` RPC. */
  id: string;
  /** Monotonic step counter starting at 1. */
  step: number;
  /** Compact event payload — tool name, args summary, brief result preview. */
  event:
    | { kind: "step-start"; toolName: string; argsPreview: string }
    | { kind: "step-finish"; toolName: string; durationMs: number; resultPreview: string }
    | { kind: "text"; text: string }
    | { kind: "todo-updated"; todos: { id: string; text: string; done: boolean }[] }
    | { kind: "user-confirmed"; outcome: "allow" | "deny" };
}

export interface AuditEventMessage {
  type: "audit-event";
  entry: {
    seq: number;
    ts: number;
    clientId: string;
    hostName: string;
    method: string;
    durationMs: number;
    outcome: "ok" | "error" | "denied" | "rate_limited";
    errorCode?: string;
  };
}

export interface ConsentGrantedMessage {
  type: "consent-granted";
  state: string;
}

export interface ConsentDeniedMessage {
  type: "consent-denied";
  state: string;
  reason?: string;
}

/**
 * Sent by the extension when a user revokes an MCP host's access from
 * the settings UI. The broker reacts by deleting all of the host's
 * refresh tokens, forcing the host through a fresh consent flow on
 * its next call.
 *
 * The broker does not currently authenticate this message beyond
 * "extension is connected" (the WS handshake gates that). A stricter
 * model — for example, requiring the extension to sign the revocation
 * with its session key — is a Phase 4 candidate.
 */
export interface RevokeHostMessage {
  type: "revoke-host";
  clientId: string;
}

export type WsMessage =
  | HelloChallengeMessage
  | HelloResponseMessage
  | HelloProofMessage
  | HelloRejectMessage
  | RpcRequestMessage
  | RpcResultMessage
  | RpcErrorMessage
  | TaskEventMessage
  | AuditEventMessage
  | ConsentGrantedMessage
  | ConsentDeniedMessage
  | RevokeHostMessage;

function hasType(x: unknown, t: string): x is { type: string } {
  return typeof x === "object" && x !== null && (x as { type: unknown }).type === t;
}

export function isHelloChallenge(x: unknown): x is HelloChallengeMessage {
  return hasType(x, "hello-challenge");
}
export function isHelloResponse(x: unknown): x is HelloResponseMessage {
  return hasType(x, "hello-response");
}
export function isHelloProof(x: unknown): x is HelloProofMessage {
  return hasType(x, "hello-proof");
}
export function isHelloReject(x: unknown): x is HelloRejectMessage {
  return hasType(x, "hello-reject");
}
export function isRpcRequest(x: unknown): x is RpcRequestMessage {
  return hasType(x, "rpc");
}
export function isRpcResult(x: unknown): x is RpcResultMessage {
  return hasType(x, "rpc-result");
}
export function isRpcError(x: unknown): x is RpcErrorMessage {
  return hasType(x, "rpc-error");
}
export function isTaskEvent(x: unknown): x is TaskEventMessage {
  return hasType(x, "task-event");
}
export function isAuditEvent(x: unknown): x is AuditEventMessage {
  return hasType(x, "audit-event");
}
export function isConsentGranted(x: unknown): x is ConsentGrantedMessage {
  return hasType(x, "consent-granted");
}
export function isConsentDenied(x: unknown): x is ConsentDeniedMessage {
  return hasType(x, "consent-denied");
}
export function isRevokeHost(x: unknown): x is RevokeHostMessage {
  return hasType(x, "revoke-host");
}

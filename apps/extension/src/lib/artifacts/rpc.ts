import type { ArtifactManifest, ArtifactSidecar } from "./manifest";

/** A captured artifact error, surfaced in the host's persistent error banner. */
export interface ArtifactError {
  /** `toast` = openbrowse.toast({ type: "error" }); `runtime` = uncaught. */
  source: "toast" | "runtime";
  message: string;
  /** Present for runtime errors when `error.stack` is available. */
  stack?: string;
  /** `filename:line:col` for runtime errors. */
  sourceFile?: string;
  /** Recent console.error entries captured inside the iframe. */
  recentConsole?: string[];
}

// Serialized request init for a brokered fetch. The body is normalized by the
// bridge shim before sending: text bodies travel as `body` (a string); binary
// bodies (Blob/ArrayBuffer/TypedArray) travel as `bodyB64` (base64). They cannot
// travel as a raw ArrayBuffer because chrome.runtime.sendMessage serializes
// messages as JSON, which turns an ArrayBuffer into `{}`.
export interface ArtifactFetchInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  bodyB64?: string;
  credentials?: "omit" | "same-origin" | "include";
}

// Serialized response returned by the broker; the shim reconstructs a Response.
// `bodyB64` is the base64-encoded response bytes (see note above re: JSON).
export interface ArtifactFetchResult {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  bodyB64: string;
}

// Messages from the artifact iframe to the host page (window.postMessage).
export type ArtifactToHostMessage =
  | { type: "ART_RPC"; reqId: number; method: "callMcpTool"; name: string; args: unknown }
  | { type: "ART_RPC"; reqId: number; method: "runTool";     name: string; args: unknown }
  | { type: "ART_RPC"; reqId: number; method: "kv.get";      key: string }
  | { type: "ART_RPC"; reqId: number; method: "kv.set";      key: string; value: unknown }
  | { type: "ART_RPC"; reqId: number; method: "kv.delete";   key: string }
  | { type: "ART_RPC"; reqId: number; method: "kv.keys" }
  | { type: "ART_RPC"; reqId: number; method: "setCardHeight"; px: number }
  | { type: "ART_RPC"; reqId: number; method: "network.fetch"; url: string; init: ArtifactFetchInit }
  | { type: "ART_RPC"; reqId: number; method: "toast"; message: string; level?: "info" | "success" | "error"; recentConsole?: string[] }
  | { type: "ART_CONSOLE"; level: "log" | "info" | "warn" | "error"; text: string }
  | { type: "ART_RENDERED"; childCount: number; bodyTextSample: string }
  | { type: "ART_RUNTIME_ERROR"; message: string; stack?: string; sourceFile?: string; recentConsole?: string[] };

export type HostToArtifactMessage =
  | { type: "ART_RPC_OK";  reqId: number; result: unknown }
  | { type: "ART_RPC_ERR"; reqId: number; error: string }
  | { type: "ART_INIT"; theme: { mode: "light" | "dark"; vars: Record<string, string> }; identity: { id: string; title: string; mode: "tab" | "card" } }
  | { type: "ART_THEME"; theme: { mode: "light" | "dark"; vars: Record<string, string> } };

// Messages between host page and background worker (chrome.runtime.sendMessage).
export type HostToBackgroundMessage =
  | { type: "ARTIFACT_RPC_CALL_MCP"; artifactId: string; toolName: string; args: Record<string, unknown> }
  | { type: "ARTIFACT_RPC_RUN_TOOL"; artifactId: string; toolName: string; args: Record<string, unknown> }
  | { type: "ARTIFACT_RPC_NETWORK_FETCH"; artifactId: string; url: string; init: ArtifactFetchInit };

/**
 * Every host -> background artifact message type starts with this prefix.
 * The background router uses it to decide whether to dispatch to
 * `handleArtifactRpc`. Keep all `HostToBackgroundMessage` types aligned with
 * it — a message that escapes this prefix silently never reaches a handler,
 * and `chrome.runtime.sendMessage` resolves `undefined` with no error.
 */
export const ARTIFACT_RPC_PREFIX = "ARTIFACT_RPC_" as const;

/** True when `type` is a host -> background artifact RPC message. */
export function isArtifactRpcMessage(
  message: unknown,
): message is HostToBackgroundMessage {
  return (
    typeof message === "object" &&
    message !== null &&
    typeof (message as { type?: unknown }).type === "string" &&
    (message as { type: string }).type.startsWith(ARTIFACT_RPC_PREFIX)
  );
}

export type BackgroundResponse =
  | { ok: true; result: unknown }
  | { ok: false; error: string };

export interface AllowlistOk { ok: true }
export interface AllowlistErr { ok: false; error: string }

/**
 * Pure allowlist gate. Used both at the host frame (to short-circuit before
 * sending to background) and at the background worker (defence in depth).
 */
export function checkAllowlist(
  manifest: ArtifactManifest,
  sidecar: ArtifactSidecar,
  toolName: string,
): AllowlistOk | AllowlistErr {
  const entry = manifest.tools.find((t) => t.name === toolName);
  if (!entry) return { ok: false, error: `tool '${toolName}' not declared in artifact manifest` };
  if (entry.mode === "write" && !sidecar.approvedWrites.includes(toolName)) {
    return { ok: false, error: `write tool '${toolName}' not approved by user` };
  }
  return { ok: true };
}

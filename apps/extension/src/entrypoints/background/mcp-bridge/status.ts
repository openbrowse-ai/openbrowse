/**
 * Discriminated union describing the bridge's connection state.
 *
 * One value, exhaustive switch in the UI. Replaces the historical loose
 * `status` string + sidecar `pendingTofu` / `keyMismatch` fields that
 * could disagree if two SW callbacks fired in close succession.
 *
 * Every transition must go through `boot.ts:setStatus` — never mutate
 * fields directly. This invariant is what makes the emitter contract
 * (subscribers always see a consistent value) safe.
 */
export type BridgeStatus =
  | DisconnectedStatus
  | ConnectingStatus
  | AwaitingTofuStatus
  | KeyMismatchStatus
  | ConnectedStatus;

export interface DisconnectedStatus {
  kind: "disconnected";
  /** Free-form note for the UI (e.g. "broker rejected hello", "ws error"). */
  reason?: string;
  /** Wall-clock ms of the last successful connection, if any. */
  lastConnectedAt?: number;
}

export interface ConnectingStatus {
  kind: "connecting";
  /** 1-based attempt counter, useful for "Connecting… (attempt 3)" messaging. */
  attempt: number;
}

export interface AwaitingTofuStatus {
  kind: "awaiting_tofu";
  prompt: {
    fingerprint: string;
    processInfo: { pid: number; executablePath: string; startedAt: number };
    nonce: string;
    /** Optional sha256 of the broker binary. Advisory only. */
    binarySha256?: string;
  };
}

export interface KeyMismatchStatus {
  kind: "key_mismatch";
  storedFingerprint: string;
  presentedFingerprint: string;
}

export interface ConnectedStatus {
  kind: "connected";
  brokerVersion: string;
  sessionId: string;
  /** Wall-clock ms when the handshake completed. */
  connectedAt: number;
}

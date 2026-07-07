import { connectToBroker, type BrokerConnection } from "./index";
import { clearTrust } from "./tofu";
import type { BridgeStatus } from "./status";

const DEFAULT_BROKER_URL = "ws://localhost:47821/ws";
const RECONNECT_BACKOFF_MS = 5_000;
const KEEPALIVE_ALARM = "mcp-bridge:keepalive";
const KEEPALIVE_PERIOD_MINUTES = 1; // Fallback safety net; broker heartbeat is the primary keepalive

/**
 * Module-private mutable state.
 *
 * `current` is the single source of truth for the bridge status; all
 * reads go through `getStatus()` and all writes through `setStatus()`,
 * which fires listeners synchronously. No part of this module is
 * allowed to mutate `current` directly.
 *
 * `retryTimer` is the handle for the auto-reconnect backoff so that
 * `forceReconnectNow()` can cancel a pending retry without waiting it
 * out.
 *
 * `attemptCount` increments on every reconnect attempt so the UI can
 * surface "Connecting… (attempt N)" without us having to invent the
 * counter in two places.
 */
let connection: BrokerConnection | null = null;
let current: BridgeStatus = { kind: "disconnected" };
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let attemptCount = 0;
let bootUrl: string = DEFAULT_BROKER_URL;
let lastConnectedAt: number | undefined;
const listeners = new Set<(s: BridgeStatus) => void>();

export function getStatus(): BridgeStatus {
  return current;
}

/**
 * Subscribe to bridge status transitions. Returns an unsubscribe fn.
 *
 * The subscriber is called synchronously every time `setStatus` runs,
 * which means handlers must not throw and must not perform long async
 * work — they should `void`-fire-and-forget anything that does I/O.
 */
export function onStatusChange(cb: (s: BridgeStatus) => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

function setStatus(next: BridgeStatus): void {
  current = next;
  for (const cb of listeners) {
    try {
      cb(next);
    } catch {
      // Defensive: a buggy subscriber must not break the bridge.
    }
  }
}

function clearRetryTimer(): void {
  if (retryTimer !== null) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
}

/**
 * Establish (or re-establish) the WS connection. Idempotent: a no-op if
 * a connection already exists. Always increments `attemptCount` so the
 * UI sees connection lifecycle progress.
 *
 * Backoff: on disconnect, schedules a reconnect after
 * `RECONNECT_BACKOFF_MS` unless `forceReconnectNow` was called
 * meanwhile.
 */
export async function bootMcpBridge(url: string = DEFAULT_BROKER_URL): Promise<void> {
  if (connection) return;
  bootUrl = url;
  attemptCount += 1;
  setStatus({ kind: "connecting", attempt: attemptCount });

  ensureKeepaliveAlarm();

  connection = connectToBroker({
    url,
    onTofuPrompt: (info) => {
      setStatus({ kind: "awaiting_tofu", prompt: info });
    },
    onKeyMismatch: (info) => {
      setStatus({
        kind: "key_mismatch",
        storedFingerprint: info.storedFingerprint,
        presentedFingerprint: info.presentedFingerprint,
      });
    },
    onConnected: (info) => {
      lastConnectedAt = Date.now();
      attemptCount = 0; // Reset on success; next attempt starts at 1 again.
      setStatus({
        kind: "connected",
        brokerVersion: info.brokerVersion,
        sessionId: info.sessionId,
        connectedAt: lastConnectedAt,
      });
    },
    onDisconnected: () => {
      const wasConnected = current.kind === "connected";
      setStatus({
        kind: "disconnected",
        reason: wasConnected ? "broker_disconnected" : "connection_failed",
        lastConnectedAt,
      });
      // Schedule a reconnect — but only if one isn't already pending
      // and we haven't been told to stop.
      if (retryTimer === null) {
        retryTimer = setTimeout(() => {
          retryTimer = null;
          connection = null;
          void bootMcpBridge(bootUrl);
        }, RECONNECT_BACKOFF_MS);
      }
    },
  });
  await connection.start();
}

export async function acceptTofu(): Promise<void> {
  await connection?.acceptTofu();
}

export function declineTofu(): void {
  connection?.declineTofu();
  // After a decline we're effectively disconnected. The WS close from
  // `declineTofu` will fire `onDisconnected`, which transitions status
  // and schedules a retry — but the user just said no, so retrying
  // immediately would re-trigger the prompt. Instead we let the
  // backoff timer fire as normal; if the user wants to try again
  // sooner they can hit "Reconnect now" or trust the broker via the
  // panel after clearTrust.
}

export function getCurrentWs(): WebSocket | null {
  return connection?.getWebSocket() ?? null;
}

/**
 * Cancel any pending backoff and reconnect immediately.
 *
 * Used by the "Reconnect now" button in the settings panel, and by
 * `clearTrustAndReconnect` after wiping the trusted fingerprint.
 */
export async function forceReconnectNow(): Promise<void> {
  clearRetryTimer();
  // Tear down any existing connection so `bootMcpBridge` doesn't
  // short-circuit on the `if (connection) return` guard.
  connection?.stop();
  connection = null;
  await bootMcpBridge(bootUrl);
}

/**
 * Drop the pinned broker fingerprint and reconnect. After this the
 * next `hello-challenge` triggers a fresh TOFU prompt regardless of
 * what fingerprint the broker presents.
 *
 * Used by the key-mismatch flow when the user has verified out-of-band
 * that the broker key was rotated legitimately.
 */
export async function clearTrustAndReconnect(): Promise<void> {
  await clearTrust();
  await forceReconnectNow();
}

// ---------------------------------------------------------------------------
// MV3 keepalive: chrome.alarms survive SW death and wake it on fire.
// ---------------------------------------------------------------------------

function ensureKeepaliveAlarm(): void {
  chrome.alarms.get(KEEPALIVE_ALARM, (existing) => {
    if (!existing) {
      chrome.alarms.create(KEEPALIVE_ALARM, {
        periodInMinutes: KEEPALIVE_PERIOD_MINUTES,
      });
    }
  });
}

/**
 * Alarm handler — wakes the SW periodically to verify the WS is alive.
 * If the connection was lost (module state reset by SW restart), boots
 * a fresh connection.
 */
export function handleKeepaliveAlarm(alarm: chrome.alarms.Alarm): void {
  if (alarm.name !== KEEPALIVE_ALARM) return;
  if (!connection || current.kind === "disconnected") {
    connection = null;
    void bootMcpBridge(bootUrl);
  }
}

import { useEffect, useState } from "react";
import type {
  AwaitingTofuStatus,
  BridgeStatus,
  ConnectedStatus,
  KeyMismatchStatus,
} from "@/entrypoints/background/mcp-bridge/status";
import { InlineHelp } from "@/components/ui/inline-help";
import { useBridgeStatus } from "./useBridgeStatus";

/**
 * Pure helpers, exported for unit testing. Same pattern as
 * `HostsList`: keep all message-shape and presentation logic out of
 * JSX so it can be asserted without a DOM.
 */

export function buildAcceptTofuMessage(): { type: "MCP_BRIDGE_ACCEPT_TOFU" } {
  return { type: "MCP_BRIDGE_ACCEPT_TOFU" };
}

export function buildDeclineTofuMessage(): { type: "MCP_BRIDGE_DECLINE_TOFU" } {
  return { type: "MCP_BRIDGE_DECLINE_TOFU" };
}

export function buildClearTrustMessage(): { type: "MCP_BRIDGE_CLEAR_TRUST" } {
  return { type: "MCP_BRIDGE_CLEAR_TRUST" };
}

export function buildForceReconnectMessage(): { type: "MCP_BRIDGE_FORCE_RECONNECT" } {
  return { type: "MCP_BRIDGE_FORCE_RECONNECT" };
}

/**
 * Render a fingerprint as colon-separated hex pairs for readability.
 */
export function formatFingerprint(fp: string): string {
  return fp.match(/.{1,2}/g)?.join(":") ?? fp;
}

/**
 * Short SHA-256 display: first 8 + last 8.
 */
export function shortHash(hex: string): string {
  if (hex.length <= 20) return hex;
  return `${hex.slice(0, 8)}…${hex.slice(-8)}`;
}

export function formatRelative(ts: number, now: number): string {
  const delta = Math.max(0, now - ts);
  const sec = Math.floor(delta / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
}

/**
 * Pure helper, exported for unit testing: maps a BridgeStatus to a
 * short pill summary. Used by the compact top-of-tab pill.
 */
export function statusPillFor(status: BridgeStatus): {
  label: string;
  color: "green" | "amber" | "red" | "gray";
} {
  switch (status.kind) {
    case "connected":
      return { label: "Ready", color: "green" };
    case "connecting":
      return { label: "Connecting…", color: "gray" };
    case "disconnected":
      return { label: "Not connected", color: "gray" };
    case "awaiting_tofu":
      return { label: "Needs your approval", color: "amber" };
    case "key_mismatch":
      return { label: "MCP helper key changed", color: "red" };
  }
}

const PILL_COLORS: Record<
  ReturnType<typeof statusPillFor>["color"],
  { dot: string; ring: string; text: string }
> = {
  green: {
    dot: "#10b981",
    ring: "ring-emerald-500/40",
    text: "text-emerald-700 dark:text-emerald-300",
  },
  amber: {
    dot: "#f59e0b",
    ring: "ring-amber-500/40",
    text: "text-amber-700 dark:text-amber-300",
  },
  red: {
    dot: "#ef4444",
    ring: "ring-red-500/40",
    text: "text-red-700 dark:text-red-300",
  },
  gray: {
    dot: "#9ca3af",
    ring: "ring-zinc-400/40",
    text: "text-muted-foreground",
  },
};

export interface ConnectionStatusPanelProps {
  /** Override for tests — defaults to `Date.now`. */
  now?: () => number;
}

/**
 * Top-of-tab status pill. Compact by default; clicking expands an
 * inline details panel. Two cases force-expand because the user must
 * act: `awaiting_tofu` and `key_mismatch`. Other states stay collapsed
 * until the user opts in.
 */
export function ConnectionStatusPanel({
  now = Date.now,
}: ConnectionStatusPanelProps = {}) {
  const status = useBridgeStatus();
  const [userOpen, setUserOpen] = useState(false);
  const forceOpen =
    status.kind === "awaiting_tofu" || status.kind === "key_mismatch";
  const open = forceOpen || userOpen;

  const pill = statusPillFor(status);
  const colors = PILL_COLORS[pill.color];

  return (
    <div>
      <button
        type="button"
        onClick={() => {
          if (forceOpen) return; // Action-required panels can't be collapsed.
          setUserOpen((v) => !v);
        }}
        className={`inline-flex items-center gap-2 rounded-full bg-background px-3 py-1 text-xs ring-1 ${colors.ring} ${colors.text} hover:bg-accent`}
        aria-expanded={open}
      >
        <span
          aria-hidden
          className="inline-block size-2 rounded-full"
          style={{ backgroundColor: colors.dot }}
        />
        <span>{pill.label}</span>
        {!forceOpen && (
          <span className="text-muted-foreground">{open ? "▾" : "▸"}</span>
        )}
      </button>

      {open && (
        <div className="mt-3">
          <DetailsForStatus status={status} now={now} />
        </div>
      )}
    </div>
  );
}

function DetailsForStatus({
  status,
  now,
}: {
  status: BridgeStatus;
  now: () => number;
}) {
  switch (status.kind) {
    case "disconnected":
      return <DisconnectedDetails lastConnectedAt={status.lastConnectedAt} now={now} />;
    case "connecting":
      return <ConnectingDetails attempt={status.attempt} />;
    case "awaiting_tofu":
      return <AwaitingTofuDetails status={status} />;
    case "key_mismatch":
      return <KeyMismatchDetails status={status} />;
    case "connected":
      return <ConnectedDetails status={status} now={now} />;
  }
}

function DisconnectedDetails({
  lastConnectedAt,
  now,
}: {
  lastConnectedAt?: number;
  now: () => number;
}) {
  return (
    <div className="rounded border border-border bg-muted/30 p-3 text-sm">
      <p className="text-muted-foreground">
        MCP clients can't reach OpenBrowse right now. This usually means
        the OpenBrowse MCP helper isn't running.
        {lastConnectedAt != null && (
          <> Last connected {formatRelative(lastConnectedAt, now())}.</>
        )}
      </p>
      <button
        type="button"
        onClick={() => void chrome.runtime.sendMessage(buildForceReconnectMessage())}
        className="mt-2 rounded border border-border px-2 py-1 text-xs hover:bg-accent"
      >
        Try to reconnect
      </button>
    </div>
  );
}

function ConnectingDetails({ attempt }: { attempt: number }) {
  // Surface the attempt number only after the first attempt — a fresh
  // user starting OpenBrowse for the first time doesn't need to see
  // "(attempt 1)".
  return (
    <div className="rounded border border-border bg-muted/30 p-3 text-sm text-muted-foreground">
      Connecting to the OpenBrowse MCP helper…
      {attempt > 1 && <> (try {attempt})</>}
    </div>
  );
}

function AwaitingTofuDetails({ status }: { status: AwaitingTofuStatus }) {
  const { prompt } = status;
  return (
    <div className="rounded border border-amber-500/60 bg-amber-50/30 p-3 dark:border-amber-500/40 dark:bg-amber-950/20">
      <p className="text-sm">
        A new MCP helper just showed up on your computer. Before
        OpenBrowse talks to it,{" "}
        <InlineHelp term="verify">
          The fingerprint below uniquely identifies this MCP helper. If
          you installed OpenBrowse yourself, this is almost certainly
          legitimate. If you weren't expecting this — for example,
          you've never installed an OpenBrowse helper — click Cancel
          and don't trust it.
        </InlineHelp>{" "}
        it's the one you installed.
      </p>
      <dl className="mt-3 grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 text-xs">
        <dt className="text-muted-foreground">
          <InlineHelp term="Fingerprint">
            A short cryptographic identifier derived from the helper's
            public key. It changes only if the helper is reinstalled
            with a new key. Compare against the value printed when you
            installed OpenBrowse.
          </InlineHelp>
        </dt>
        <dd className="font-mono break-all">{formatFingerprint(prompt.fingerprint)}</dd>
        <dt className="text-muted-foreground">Process</dt>
        <dd className="font-mono break-all">
          {prompt.processInfo.executablePath} (PID {prompt.processInfo.pid})
        </dd>
        {prompt.binarySha256 && (
          <>
            <dt className="text-muted-foreground">Binary checksum</dt>
            <dd className="font-mono">{shortHash(prompt.binarySha256)}</dd>
          </>
        )}
      </dl>
      <div className="mt-3 flex gap-2">
        <button
          type="button"
          onClick={() => void chrome.runtime.sendMessage(buildAcceptTofuMessage())}
          className="rounded bg-amber-600 px-3 py-1 text-xs font-medium text-white hover:bg-amber-700"
        >
          Verify and trust
        </button>
        <button
          type="button"
          onClick={() => void chrome.runtime.sendMessage(buildDeclineTofuMessage())}
          className="rounded border border-border px-3 py-1 text-xs hover:bg-accent"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

function KeyMismatchDetails({ status }: { status: KeyMismatchStatus }) {
  const [confirming, setConfirming] = useState(false);
  return (
    <div className="rounded border border-red-500/60 bg-red-50/30 p-3 dark:border-red-500/40 dark:bg-red-950/20">
      <p className="text-sm">
        The OpenBrowse MCP helper on your computer is presenting a
        different identity than the one OpenBrowse remembered. This
        usually means you updated OpenBrowse, but it could also mean
        the helper was replaced without your knowledge. Don't trust the
        new identity unless you're sure you updated it yourself.
      </p>
      <dl className="mt-3 grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 text-xs">
        <dt className="text-muted-foreground">Previously trusted</dt>
        <dd className="font-mono break-all">{formatFingerprint(status.storedFingerprint)}</dd>
        <dt className="text-muted-foreground">Showing up now</dt>
        <dd className="font-mono break-all">{formatFingerprint(status.presentedFingerprint)}</dd>
      </dl>
      <div className="mt-3 flex gap-2">
        {!confirming ? (
          <button
            type="button"
            onClick={() => setConfirming(true)}
            className="rounded bg-red-600 px-3 py-1 text-xs font-medium text-white hover:bg-red-700"
          >
            Trust the new identity
          </button>
        ) : (
          <>
            <button
              type="button"
              onClick={() => void chrome.runtime.sendMessage(buildClearTrustMessage())}
              className="rounded bg-red-600 px-3 py-1 text-xs font-medium text-white hover:bg-red-700"
            >
              Confirm — replace trust
            </button>
            <button
              type="button"
              onClick={() => setConfirming(false)}
              className="rounded border border-border px-3 py-1 text-xs hover:bg-accent"
            >
              Cancel
            </button>
          </>
        )}
      </div>
    </div>
  );
}

function ConnectedDetails({
  status,
  now,
}: {
  status: ConnectedStatus;
  now: () => number;
}) {
  // Tick once a second so the "Connected" caption stays current.
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, []);
  return (
    <div className="rounded border border-emerald-500/60 bg-emerald-50/30 p-3 dark:border-emerald-500/40 dark:bg-emerald-950/20">
      <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 text-xs">
        <dt className="text-muted-foreground">MCP helper version</dt>
        <dd className="font-mono">{status.brokerVersion || "(unknown)"}</dd>
        <dt className="text-muted-foreground">Session id</dt>
        <dd className="font-mono break-all">{status.sessionId}</dd>
        <dt className="text-muted-foreground">Connected</dt>
        <dd>{formatRelative(status.connectedAt, now())}</dd>
      </dl>
    </div>
  );
}

// src/entrypoints/settings/memory-sync/MemorySyncSection.tsx
//
// The memory-sync panel: link a folder that carries the agent's global memory
// between Chrome profiles, and report what the last pass actually did.
//
// Rendered inside a popover anchored on the Memory header (see
// `MemorySyncButton`), not stacked above the tree. The Memory tab is a
// full-height master/detail, so anything placed above it shortens both panes for
// a control the user touches roughly twice per profile.
//
// Wording note: "lapsed" is phrased as a chore, not a fault. Chrome drops File
// System Access grants at the start of every browser session, so a returning
// user hits that state more often than any other — dressing it up as an error
// would teach them to distrust a feature that is working as designed. Only
// `error`, which the hook sets exclusively for explicit user actions, gets
// destructive styling.

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { UseMemorySync } from "@/hooks/useMemorySync";
import type { TransportStatus } from "@/lib/memory/sync/types";
import type { MemorySyncLastResult } from "@/lib/types";
import { useEffect, useState } from "react";
import { ConflictsPanel, formatAgo } from "./ConflictsPanel";

const LABEL_INPUT_ID = "memory-sync-profile-label";

/**
 * Takes the hook's value rather than calling it, so the trigger button and the
 * panel share one instance — two `useMemorySync()` calls would mean two sets of
 * triggers and two sync passes racing each other.
 */
export function MemorySyncSection({ sync: state }: { sync: UseMemorySync }) {
  const {
    ready,
    status,
    settings,
    syncing,
    conflicts,
    error,
    link,
    reconnect,
    unlink,
    sync,
    setLabel,
    restore,
    dismiss,
  } = state;

  // Rendering nothing until the hook's first state read lands beats flashing
  // the "no folder linked" pitch at someone who linked one months ago.
  // `settings` is re-checked only to narrow the type — it is always set once
  // `ready` is true.
  if (!ready || !settings) return null;

  const linked = status !== "unset";

  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <h3 className="text-sm font-medium">Memory sync</h3>
        {linked ? (
          <p className="text-xs text-muted-foreground">
            Global memory syncs through{" "}
            <span className="font-medium text-foreground">
              {settings.vaultName ?? "the linked folder"}
            </span>
            .
          </p>
        ) : (
          <>
            <p className="text-xs text-muted-foreground">
              Pick the same folder in each of your Chrome profiles and the
              agent's global memory stays in sync between them. Keep that folder
              in Dropbox, iCloud Drive, Google Drive, or a git repo and it
              follows you across machines too.
            </p>
            <p className="text-xs text-muted-foreground">
              Anything you put in the folder's{" "}
              <code className="font-mono">memory/</code> directory becomes
              readable by the agent, so choose a folder you control.
            </p>
          </>
        )}
      </div>

      {linked ? (
        <>
          <ProfileLabelField
            value={settings.profileLabel}
            onCommit={setLabel}
          />

          <div className="space-y-1">
            <StatusLine
              status={status}
              syncing={syncing}
              lastSyncAt={settings.lastSyncAt}
              onLink={link}
              onReconnect={reconnect}
            />
            <ResultCounts result={settings.lastResult} />
          </div>

          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => void sync()}
              disabled={syncing}
            >
              Sync now
            </Button>
            <Button variant="ghost" size="sm" onClick={() => void unlink()}>
              Stop syncing
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Stopping just forgets the folder. Nothing is deleted — the memory
            here and the files in the folder both stay exactly as they are.
          </p>
        </>
      ) : (
        <Button variant="outline" size="sm" onClick={() => void link()}>
          Choose folder…
        </Button>
      )}

      {error !== null && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}

      {conflicts.length > 0 && (
        <ConflictsPanel
          conflicts={conflicts}
          onRestore={restore}
          onDismiss={dismiss}
        />
      )}
    </div>
  );
}

function ProfileLabelField({
  value,
  onCommit,
}: {
  value: string;
  onCommit: (label: string) => Promise<void>;
}) {
  const [draft, setDraft] = useState(value);

  // Adopt an externally changed label (another surface, or a sync refresh)
  // without fighting the user mid-edit: this only fires when the stored value
  // itself changes, and a commit stores what was typed.
  useEffect(() => setDraft(value), [value]);

  // Committing on blur rather than per keystroke: every save writes settings
  // and kicks off a refresh, which is far too much for one character.
  const commit = () => {
    const next = draft.trim();
    if (next === value) return;
    void onCommit(next);
  };

  return (
    <div className="space-y-1">
      <Label htmlFor={LABEL_INPUT_ID}>This profile</Label>
      <Input
        id={LABEL_INPUT_ID}
        className="max-w-64"
        value={draft}
        placeholder="e.g. Work"
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
        }}
      />
      <p className="text-xs text-muted-foreground">
        Identifies this profile on any conflict it causes, so you can tell which
        Chrome profile made a change.
      </p>
    </div>
  );
}

function StatusLine({
  status,
  syncing,
  lastSyncAt,
  onLink,
  onReconnect,
}: {
  status: TransportStatus;
  syncing: boolean;
  lastSyncAt: number | null;
  onLink: () => Promise<void>;
  onReconnect: () => Promise<void>;
}) {
  if (syncing) {
    return <p className="text-xs text-muted-foreground">Syncing…</p>;
  }

  // Routine: the grant is gone because the browser restarted, not because
  // anything is broken. Muted tone, one click to fix.
  if (status === "lapsed") {
    return (
      <StatusWithAction
        message="Reconnect the folder to resume syncing."
        actionLabel="Reconnect"
        onAction={onReconnect}
      />
    );
  }

  if (status === "missing") {
    return (
      <StatusWithAction
        tone="warning"
        message="The sync folder was moved or deleted."
        actionLabel="Choose folder…"
        onAction={onLink}
      />
    );
  }

  if (status === "denied") {
    return (
      <StatusWithAction
        tone="warning"
        message="Folder access was denied."
        actionLabel="Reconnect"
        onAction={onReconnect}
      />
    );
  }

  return (
    <p className="text-xs text-muted-foreground">
      {lastSyncAt === null ? "Not synced yet" : "Synced " + formatAgo(lastSyncAt)}
    </p>
  );
}

function StatusWithAction({
  tone = "muted",
  message,
  actionLabel,
  onAction,
}: {
  tone?: "muted" | "warning";
  message: string;
  actionLabel: string;
  onAction: () => Promise<void>;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <p
        className={
          tone === "warning"
            ? "text-xs text-amber-700 dark:text-amber-300"
            : "text-xs text-muted-foreground"
        }
      >
        {message}
      </p>
      <Button variant="outline" size="xs" onClick={() => void onAction()}>
        {actionLabel}
      </Button>
    </div>
  );
}

function ResultCounts({ result }: { result?: MemorySyncLastResult }) {
  if (!result) return null;

  const counts: string[] = [];
  if (result.pulled > 0) counts.push(result.pulled + " pulled");
  if (result.pushed > 0) counts.push(result.pushed + " pushed");
  if (result.deleted > 0) counts.push(result.deleted + " deleted");

  // Resurrections and skips need a sentence rather than a count: neither is
  // self-explanatory next to "3 pulled".
  const notes: string[] = [];
  if (result.resurrected > 0) {
    notes.push(
      result.resurrected +
        (result.resurrected === 1 ? " note was" : " notes were") +
        " restored after being deleted in another profile.",
    );
  }
  if (result.skipped > 0) {
    notes.push(
      result.skipped +
        (result.skipped === 1 ? " file was" : " files were") +
        " skipped.",
    );
  }

  if (counts.length === 0 && notes.length === 0) return null;

  return (
    <>
      {counts.length > 0 && (
        <p className="text-xs text-muted-foreground">{counts.join(" · ")}</p>
      )}
      {notes.map((note) => (
        <p key={note} className="text-xs text-muted-foreground">
          {note}
        </p>
      ))}
    </>
  );
}

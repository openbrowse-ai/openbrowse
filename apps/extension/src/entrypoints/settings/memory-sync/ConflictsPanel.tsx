// src/entrypoints/settings/memory-sync/ConflictsPanel.tsx
//
// The losing copies of last-write-wins conflicts.
//
// They are archived outside the memory folder on purpose: the agent reads
// everything under memory/, so parking a second copy of a note there would
// surface the same fact twice and quietly corrupt the note graph. That is also
// why the only two actions are "make this the live note" and "throw it away" —
// there is nowhere for a conflict copy to sit indefinitely.

import { Button } from "@/components/ui/button";
import type { ConflictEntry } from "@/lib/memory/sync/types";

/**
 * Long-form relative time ("just now", "2 minutes ago").
 *
 * Defined here rather than alongside the section that renders this panel so
 * both files can share one definition without a child importing from its
 * parent. `now` is injectable for tests.
 */
export function formatAgo(at: number, now: number = Date.now()): string {
  const sec = Math.max(0, Math.round((now - at) / 1000));
  if (sec < 45) return "just now";
  const min = Math.round(sec / 60);
  if (min < 60) return min + (min === 1 ? " minute ago" : " minutes ago");
  const hr = Math.round(min / 60);
  if (hr < 24) return hr + (hr === 1 ? " hour ago" : " hours ago");
  const day = Math.round(hr / 24);
  return day + (day === 1 ? " day ago" : " days ago");
}

export interface ConflictsPanelProps {
  conflicts: ConflictEntry[];
  onRestore: (entry: ConflictEntry) => void | Promise<void>;
  onDismiss: (archivedPath: string) => void | Promise<void>;
}

export function ConflictsPanel({
  conflicts,
  onRestore,
  onDismiss,
}: ConflictsPanelProps) {
  if (conflicts.length === 0) return null;

  return (
    <div className="space-y-2 rounded-lg border border-border bg-muted/30 p-3">
      <div className="space-y-0.5">
        <h4 className="text-sm font-medium">Conflicting copies</h4>
        <p className="text-xs text-muted-foreground">
          Two profiles edited the same note, so the newer edit won and the older
          copy was kept aside — outside the memory folder, so it doesn't show up
          twice in the agent's notes. Restoring makes a copy the live note again.
        </p>
      </div>

      <ul className="divide-y divide-border/60">
        {conflicts.map((entry) => (
          <li
            key={entry.archivedPath}
            className="flex items-center justify-between gap-3 py-2"
          >
            <div className="min-w-0">
              <div className="truncate font-mono text-xs">{entry.path}</div>
              <div className="text-xs text-muted-foreground">
                {formatAgo(entry.at)}
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <Button
                variant="outline"
                size="xs"
                onClick={() => void onRestore(entry)}
                aria-label={"Restore the conflicting copy of " + entry.path}
              >
                Restore
              </Button>
              <Button
                variant="ghost"
                size="xs"
                onClick={() => void onDismiss(entry.archivedPath)}
                aria-label={"Dismiss the conflicting copy of " + entry.path}
              >
                Dismiss
              </Button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import type {
  ConcernDimension,
  EvaluatorVerdict,
  GateOutcome,
  SkipReason,
} from "./types";

/**
 * Telemetry store for completion-check gate verdicts.
 *
 * Lives in its own IndexedDB database (separate from `chat-db`) so:
 *  - Schema can evolve independently as the verdict shape grows
 *  - Wiping telemetry doesn't risk touching conversation transcripts
 *  - Future "export anonymized telemetry" / "clear telemetry" UI can act
 *    on a clean store without rebuilding the whole chat database
 *
 * Local-only: nothing here is uploaded anywhere. The data exists so the
 * future telemetry UI can show users what the evaluator has been doing
 * on their behalf, and so prompt-tuning can read aggregated
 * rejection-reason distributions.
 *
 * Design choices:
 *  - One row per verdict (one conversation turn may produce multiple rows
 *    if rejected and retried). `id` is a fresh uuid per row, not derived
 *    from the conversation, so an append-only log is straightforward.
 *  - We store the verdict as a denormalized blob. It's small (~few KB
 *    worst case) and avoids cross-store joins for analysis.
  *  - We extract concern dimensions into an indexed array so common
 *    queries ("how often did we reject for planClosure?") don't
 *    scan every row.
 */

export interface CompletionCheckTelemetryRow {
  /** Random uuid; NOT correlated with conversation/turn ids. */
  id: string;
  conversationId: string;
  /**
   * 0-indexed turn within the conversation. Used to group multiple rows
   * (rejection rounds) belonging to the same logical turn.
   */
  turnIndex: number;
  /**
   * 0 for the first verdict in a turn, 1 for the second (after first
   * rejection), and so on. Together with `turnIndex` uniquely identifies
   * a verdict within a conversation.
   */
  rejectionRound: number;
  /** Wall-clock at the moment the verdict was recorded, ms since epoch. */
  timestamp: number;
  /**
   * Coarse outcome bucket; redundant with `verdict.decision` for
   * approve/reject but also captures skipped and force-emitted cases
   * which don't have a meaningful `decision`.
   */
  outcomeKind: GateOutcome["kind"];
  /**
   * The structured verdict, when one was produced. Null when the gate
   * was skipped (`outcomeKind === "skipped"`).
   */
  verdict: EvaluatorVerdict | null;
  /**
   * Distinct concern dimensions raised in this verdict, lifted out for
   * indexing. Empty array when the verdict approved or was skipped.
   */
  concernDimensions: ConcernDimension[];
  /**
   * Why the gate skipped, if it did. Lets us distinguish "no final
   * text" from "trigger said skip" without parsing the verdict.
   */
  skipReason?: SkipReason;
}

interface TelemetryDB extends DBSchema {
  verdicts: {
    key: string; // row id
    value: CompletionCheckTelemetryRow;
    indexes: {
      "by-conversation": string;
      "by-timestamp": number;
      "by-outcome": string;
    };
  };
}

const DB_NAME = "openbrowse-completion-check-telemetry";
const DB_VERSION = 1;

let dbPromise: Promise<IDBPDatabase<TelemetryDB>> | null = null;

function getDb(): Promise<IDBPDatabase<TelemetryDB>> {
  if (!dbPromise) {
    dbPromise = openDB<TelemetryDB>(DB_NAME, DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains("verdicts")) {
          const store = db.createObjectStore("verdicts", { keyPath: "id" });
          store.createIndex("by-conversation", "conversationId");
          store.createIndex("by-timestamp", "timestamp");
          store.createIndex("by-outcome", "outcomeKind");
        }
      },
    });
  }
  return dbPromise;
}

/**
 * Convenience constructor that derives `concernDimensions` from a
 * verdict and fills in the row id + timestamp. Callers usually use this
 * over building rows by hand.
 */
function buildRow(
  args: Omit<
    CompletionCheckTelemetryRow,
    "id" | "timestamp" | "concernDimensions"
  > & { id?: string; timestamp?: number },
): CompletionCheckTelemetryRow {
  const dimensions = new Set<ConcernDimension>();
  for (const c of args.verdict?.concerns ?? []) {
    dimensions.add(c.dimension);
  }
  return {
    id: args.id ?? crypto.randomUUID(),
    timestamp: args.timestamp ?? Date.now(),
    concernDimensions: [...dimensions],
    ...args,
  };
}

export const completionCheckTelemetry = {
  /**
   * Append a new verdict row. Returns the row id so callers can
   * cross-reference (e.g. for later "this verdict was wrong" feedback).
   */
  async record(
    args: Omit<
      CompletionCheckTelemetryRow,
      "id" | "timestamp" | "concernDimensions"
    > & { id?: string; timestamp?: number },
  ): Promise<string> {
    const row = buildRow(args);
    const db = await getDb();
    await db.put("verdicts", row);
    return row.id;
  },

  /**
   * All verdict rows for a conversation, sorted by timestamp ascending.
   * Most callers want the conversation-scoped view; the global view
   * (`listAll`) is for the future telemetry-aggregation UI.
   *
   * Timestamps are millisecond-resolution `Date.now()` values, so rows
   * recorded within the same millisecond can tie. We break ties by
   * `turnIndex` then `rejectionRound` — both monotonically increasing in
   * insertion order within a turn — so equal-timestamp rows return in a
   * deterministic, insertion-consistent order instead of relying on the
   * IndexedDB primary-key (random uuid) ordering.
   */
  async listForConversation(
    conversationId: string,
  ): Promise<CompletionCheckTelemetryRow[]> {
    const db = await getDb();
    const rows = await db.getAllFromIndex(
      "verdicts",
      "by-conversation",
      conversationId,
    );
    return rows.sort(
      (a, b) =>
        a.timestamp - b.timestamp ||
        a.turnIndex - b.turnIndex ||
        a.rejectionRound - b.rejectionRound,
    );
  },

  /**
   * All verdict rows globally, sorted newest-first. Used by the future
   * settings telemetry pane to show recent activity. Unbounded; UI is
   * expected to limit/scroll. We don't paginate here because IndexedDB
   * cursor pagination is more complex than we need for what is, in
   * practice, low-volume.
   */
  async listAll(): Promise<CompletionCheckTelemetryRow[]> {
    const db = await getDb();
    const rows = await db.getAllFromIndex("verdicts", "by-timestamp");
    return rows.reverse();
  },

  /**
   * Aggregate stats for the settings UI: counts by outcome kind and by
   * concern dimension, optionally scoped to a sliding window.
   */
  async aggregate(opts?: { sinceMs?: number }): Promise<{
    totalVerdicts: number;
    byOutcome: Record<GateOutcome["kind"], number>;
    byDimension: Record<ConcernDimension, number>;
  }> {
    const rows = await this.listAll();
    const cutoff = opts?.sinceMs ?? 0;
    const filtered = cutoff > 0 ? rows.filter((r) => r.timestamp >= cutoff) : rows;

    const byOutcome: Record<GateOutcome["kind"], number> = {
      skipped: 0,
      approved: 0,
      rejected: 0,
      "force-emitted": 0,
    };
    const byDimension: Record<ConcernDimension, number> = {
      completeness: 0,
      planClosure: 0,
      noPrematureHandoff: 0,
    };
    for (const row of filtered) {
      byOutcome[row.outcomeKind] = (byOutcome[row.outcomeKind] ?? 0) + 1;
      for (const d of row.concernDimensions) {
        // Old persisted rows may carry retired dimensions
        // (`evidenceGrounding`, `surfaceAccuracy` from earlier
        // revisions). Skip unknown keys silently rather than letting
        // them pollute the aggregation as dynamically-created fields.
        if (d in byDimension) {
          byDimension[d] = (byDimension[d] ?? 0) + 1;
        }
      }
    }
    return {
      totalVerdicts: filtered.length,
      byOutcome,
      byDimension,
    };
  },

  /**
   * Drop all telemetry rows. Backs the "Clear telemetry" settings button.
   */
  async clear(): Promise<void> {
    const db = await getDb();
    await db.clear("verdicts");
  },

  /**
   * Test/debug helper. Reset per-test telemetry state: clear the
   * `verdicts` store so rows can't leak across tests (with
   * `fake-indexeddb`, the backing store is global and persists between
   * tests in the same file), then drop the cached db handle so a fresh
   * `indexedDB` (e.g. a newly-assigned `IDBFactory`) is opened on next
   * call.
   */
  async _resetForTests(): Promise<void> {
    try {
      const db = await getDb();
      await db.clear("verdicts");
    } catch {
      // Store may not exist yet, or the cached handle may point at a
      // torn-down factory; either way a stale handle is about to be
      // dropped below, so swallow.
    }
    dbPromise = null;
  },
};

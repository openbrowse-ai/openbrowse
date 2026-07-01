export interface AuditEntry {
  seq: number;
  ts: number;
  clientId: string;
  hostName: string;
  method: string;
  durationMs: number;
  outcome: "ok" | "error" | "denied" | "rate_limited";
  errorCode?: string;
}

export interface AuditStore {
  append(entry: Omit<AuditEntry, "seq" | "ts">): void;
  list(): AuditEntry[];
  size(): number;
}

export function createAuditStore(capacity: number): AuditStore {
  const ring: AuditEntry[] = [];
  let seq = 0;
  return {
    append(input) {
      const entry: AuditEntry = { ...input, seq: ++seq, ts: Date.now() };
      ring.push(entry);
      while (ring.length > capacity) ring.shift();
    },
    list() {
      return [...ring];
    },
    size() {
      return ring.length;
    },
  };
}

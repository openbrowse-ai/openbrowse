export interface RefEntry {
  backendNodeId: number;
  role: string;
  name: string;
}

interface TabRefs {
  refs: Map<string, RefEntry>;
  previousSnapshot: string | null;
}

const refsByTab = new Map<number, TabRefs>();

export function setRefs(tabId: number, refs: Map<string, RefEntry>, snapshotText: string): void {
  refsByTab.set(tabId, { refs, previousSnapshot: snapshotText });
}

export function getRef(tabId: number, ref: string): RefEntry | undefined {
  return refsByTab.get(tabId)?.refs.get(ref);
}

export function getRefsForTab(tabId: number): Map<string, RefEntry> | undefined {
  return refsByTab.get(tabId)?.refs;
}

export function getPreviousSnapshot(tabId: number): string | null {
  return refsByTab.get(tabId)?.previousSnapshot ?? null;
}

export function invalidateRefs(tabId: number): void {
  refsByTab.delete(tabId);
}

export function hasRefs(tabId: number): boolean {
  const entry = refsByTab.get(tabId);
  return !!entry && entry.refs.size > 0;
}

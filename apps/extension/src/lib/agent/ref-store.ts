import type { TabId } from "./driver";

export interface RefEntry {
  backendNodeId: number;
  role: string;
  name: string;
}

interface TabRefs {
  refs: Map<string, RefEntry>;
  previousSnapshot: string | null;
}

const refsByTab = new Map<TabId, TabRefs>();

export function setRefs(tabId: TabId, refs: Map<string, RefEntry>, snapshotText: string): void {
  refsByTab.set(tabId, { refs, previousSnapshot: snapshotText });
}

export function getRef(tabId: TabId, ref: string): RefEntry | undefined {
  return refsByTab.get(tabId)?.refs.get(ref);
}

export function getRefsForTab(tabId: TabId): Map<string, RefEntry> | undefined {
  return refsByTab.get(tabId)?.refs;
}

export function getPreviousSnapshot(tabId: TabId): string | null {
  return refsByTab.get(tabId)?.previousSnapshot ?? null;
}

export function invalidateRefs(tabId: TabId): void {
  refsByTab.delete(tabId);
}

export function hasRefs(tabId: TabId): boolean {
  const entry = refsByTab.get(tabId);
  return !!entry && entry.refs.size > 0;
}

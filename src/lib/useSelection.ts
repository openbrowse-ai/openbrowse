import { useCallback, useRef, useState } from "react";

export function useSelection() {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const lastToggledRef = useRef<string | null>(null);

  const toggle = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
    lastToggledRef.current = id;
  }, []);

  const extendTo = useCallback((id: string, orderedIds: string[]) => {
    const anchor = lastToggledRef.current;
    if (!anchor) {
      setSelectedIds(new Set([id]));
      lastToggledRef.current = id;
      return;
    }
    const anchorIndex = orderedIds.indexOf(anchor);
    const targetIndex = orderedIds.indexOf(id);
    if (anchorIndex === -1 || targetIndex === -1) return;
    const start = Math.min(anchorIndex, targetIndex);
    const end = Math.max(anchorIndex, targetIndex);
    const range = orderedIds.slice(start, end + 1);
    setSelectedIds((prev) => {
      const next = new Set(prev);
      for (const rangeId of range) {
        next.add(rangeId);
      }
      return next;
    });
  }, []);

  const selectAll = useCallback((orderedIds: string[]) => {
    setSelectedIds(new Set(orderedIds));
  }, []);

  const clear = useCallback(() => {
    setSelectedIds(new Set());
    lastToggledRef.current = null;
  }, []);

  const isSelected = useCallback(
    (id: string) => selectedIds.has(id),
    [selectedIds],
  );

  return { selectedIds, toggle, extendTo, selectAll, clear, isSelected };
}

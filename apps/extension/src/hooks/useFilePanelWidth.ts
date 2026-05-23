import { useCallback, useEffect, useState } from "react";

const STORAGE_KEY = "openbrowse-file-panel-width";

function readInitial(fallback: number): number {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw == null) return fallback;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  } catch {
    return fallback;
  }
}

/**
 * Persisted file-viewer panel width (pixels). Stored in localStorage so the
 * user's chosen size sticks across sessions. Workspace mode uses a fixed
 * width and does NOT use this hook — only file mode persists.
 *
 * The setter is stable across renders.
 */
export function useFilePanelWidth(
  fallback = 560,
): [number, (px: number) => void] {
  const [width, setWidth] = useState<number>(() => readInitial(fallback));
  const set = useCallback((px: number) => {
    setWidth(px);
    try {
      localStorage.setItem(STORAGE_KEY, String(Math.round(px)));
    } catch {
      // localStorage might be unavailable (e.g. private browsing).
    }
  }, []);
  // Cross-tab sync.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key !== STORAGE_KEY || e.newValue == null) return;
      const n = Number(e.newValue);
      if (Number.isFinite(n) && n > 0) setWidth(n);
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);
  return [width, set];
}

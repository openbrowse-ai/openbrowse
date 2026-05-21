import { useEffect, useRef, useState } from "react";

export function useTidyProgress() {
  const [progress, setProgress] = useState("");
  const wasRunning = useRef(false);

  useEffect(() => {
    function listener(changes: { [key: string]: chrome.storage.StorageChange }) {
      const p = changes._tidyProgress?.newValue as
        | { phase: number; current: number; total: number }
        | undefined;
      if (!p) return;
      if (p.phase === -1) {
        if (wasRunning.current) {
          wasRunning.current = false;
          setProgress("done");
          setTimeout(() => setProgress(""), 2000);
        } else {
          setProgress("");
        }
        return;
      }
      wasRunning.current = true;
      if (p.phase === 1) setProgress(`${p.current}/${p.total}`);
      else setProgress("...");
    }
    chrome.storage.onChanged.addListener(listener);
    return () => chrome.storage.onChanged.removeListener(listener);
  }, []);

  return progress;
}

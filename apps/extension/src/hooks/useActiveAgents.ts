import { STORAGE_KEYS } from "@/lib/constants";
import { useEffect, useState } from "react";

export function useActiveAgents(): Set<string> {
  const [activeAgents, setActiveAgents] = useState<Set<string>>(new Set());

  useEffect(() => {
    chrome.storage.local.get(STORAGE_KEYS.ACTIVE_AGENTS).then((result) => {
      const ids = (result[STORAGE_KEYS.ACTIVE_AGENTS] as string[]) ?? [];
      setActiveAgents(new Set(ids));
    });

    const listener = (
      changes: { [key: string]: chrome.storage.StorageChange },
      area: string,
    ) => {
      if (area === "local" && STORAGE_KEYS.ACTIVE_AGENTS in changes) {
        const ids = (changes[STORAGE_KEYS.ACTIVE_AGENTS].newValue as string[]) ?? [];
        setActiveAgents(new Set(ids));
      }
    };

    chrome.storage.onChanged.addListener(listener);
    return () => chrome.storage.onChanged.removeListener(listener);
  }, []);

  return activeAgents;
}

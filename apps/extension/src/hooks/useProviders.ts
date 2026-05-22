import { useEffect, useState } from "react";
import { STORAGE_KEYS } from "@/lib/constants";
import {
  getProviders,
  providers as initialProviders,
  type ProviderDefinition,
} from "@/registry/providers";
import {
  getLastUpdated as fetchLastUpdated,
} from "@/registry/models-dev/catalog";

export interface UseProvidersResult {
  providers: ProviderDefinition[];
  /**
   * Epoch ms of the last successful catalog refresh. Null until either
   * the storage cache has been written by a refresh OR the bundled
   * snapshot is being used (in which case fetchedAt is also null).
   */
  lastUpdated: number | null;
}

/**
 * Returns the current provider list (snapshot- or live-derived) and
 * the last refresh timestamp. Re-renders whenever the catalog cache
 * changes in chrome.storage.
 */
export function useProviders(): UseProvidersResult {
  const [list, setList] = useState<ProviderDefinition[]>(initialProviders);
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      const fresh = await getProviders();
      if (cancelled) return;
      setList([...fresh]);
      setLastUpdated(await fetchLastUpdated());
    })();

    const onChange = (
      changes: { [key: string]: chrome.storage.StorageChange },
      area: string,
    ) => {
      if (area !== "local") return;
      if (!(STORAGE_KEYS.MODELS_DEV_CATALOG in changes)) return;
      void (async () => {
        const fresh = await getProviders();
        if (cancelled) return;
        setList([...fresh]);
        setLastUpdated(await fetchLastUpdated());
      })();
    };

    if (typeof chrome !== "undefined" && chrome.storage?.onChanged) {
      chrome.storage.onChanged.addListener(onChange);
    }

    return () => {
      cancelled = true;
      if (typeof chrome !== "undefined" && chrome.storage?.onChanged) {
        chrome.storage.onChanged.removeListener(onChange);
      }
    };
  }, []);

  return { providers: list, lastUpdated };
}

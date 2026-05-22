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

export interface UseProvidersOptions {
  /** Surface alpha/beta models. Defaults to false (deprecated always hidden). */
  includePreview?: boolean;
}

export interface UseProvidersResult {
  providers: ProviderDefinition[];
  lastUpdated: number | null;
}

/**
 * Returns the current provider list (snapshot- or live-derived) and
 * the last refresh timestamp. Re-renders whenever the catalog cache
 * changes in chrome.storage.
 */
export function useProviders(
  options: UseProvidersOptions = {},
): UseProvidersResult {
  const { includePreview = false } = options;

  const [list, setList] = useState<ProviderDefinition[]>(initialProviders);
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      const fresh = await getProviders({ includePreview });
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
        const fresh = await getProviders({ includePreview });
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
  }, [includePreview]);

  return { providers: list, lastUpdated };
}

import { Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Settings } from "@/lib/types";
import { useProviders } from "@/hooks/useProviders";
import { Kbd } from "@/components/ui/kbd";
import { QUIRKS } from "@/registry/models-dev/quirks";
import { ProviderSection, type ModelState } from "./ProviderSection";

interface ModelsTabProps {
  settings: Settings;
  onChange: (patch: Partial<Settings>) => void;
}

/**
 * Curated providers always render at the top. Anything else (the long
 * tail of openai-compatible providers from models.dev) is hidden
 * behind a disclosure button until the user clicks "Show N more
 * providers" or types into the search box.
 */
const CURATED_IDS = new Set<string>([
  "browser-ai",
  "web-llm",
  ...Object.keys(QUIRKS),
  "openai-compatible",
]);

export function ModelsTab({ settings, onChange }: ModelsTabProps) {
  const { providers } = useProviders();
  const [modelStates, setModelStates] = useState<Record<string, ModelState>>({});
  const [query, setQuery] = useState("");
  const [showAll, setShowAll] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const [searchFocused, setSearchFocused] = useState(false);

  // "/" focuses the search box (when not already typing somewhere), so
  // the input is reachable without the mouse.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      const isEditable =
        tag === "INPUT" ||
        tag === "TEXTAREA" ||
        tag === "SELECT" ||
        target?.isContentEditable === true;
      if (isEditable) return;
      e.preventDefault();
      searchRef.current?.focus();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  // Listen for download progress messages from background
  useEffect(() => {
    function handleMessage(message: unknown) {
      const msg = message as { type?: string; modelKey?: string; progress?: number; done?: boolean; error?: string };
      if (msg.type === "DOWNLOAD_PROGRESS" && msg.modelKey) {
        setModelStates((prev) => ({
          ...prev,
          [msg.modelKey!]: {
            modelKey: msg.modelKey!,
            downloading: !msg.done && !msg.error,
            progress: msg.progress ?? 0,
            error: msg.error,
          },
        }));
      }
    }

    chrome.runtime.onMessage.addListener(handleMessage);
    return () => chrome.runtime.onMessage.removeListener(handleMessage);
  }, []);

  function handleDownload(providerId: string, modelId: string) {
    const key = `${providerId}:${modelId}`;
    setModelStates((prev) => ({
      ...prev,
      [key]: { modelKey: key, downloading: true, progress: 0 },
    }));
    if (providerId === "browser-ai") {
      chrome.runtime.sendMessage({ type: "DOWNLOAD_BROWSER_AI" });
    } else {
      chrome.runtime.sendMessage({ type: "DOWNLOAD_MODEL", modelId });
    }
  }

  function handleDelete(providerId: string, modelId: string) {
    const key = `${providerId}:${modelId}`;
    chrome.runtime.sendMessage({ type: "DELETE_MODEL", modelId });
    onChange({
      downloadedModels: settings.downloadedModels.filter((m) => m !== modelId),
      favoriteModels: settings.favoriteModels.filter((m) => m !== key),
    });
    setModelStates((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
  }

  // Filtered list — match on provider name, id, and model names.
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return providers;
    return providers.filter((p) => {
      if (p.name.toLowerCase().includes(q)) return true;
      if (p.id.toLowerCase().includes(q)) return true;
      return p.models.some((m) => m.name.toLowerCase().includes(q));
    });
  }, [providers, query]);

  const curated = useMemo(
    () => filtered.filter((p) => CURATED_IDS.has(p.id)),
    [filtered],
  );
  const longTail = useMemo(
    () => filtered.filter((p) => !CURATED_IDS.has(p.id)),
    [filtered],
  );

  const hasQuery = query.trim().length > 0;
  // While searching, expand the long tail so the search isn't lying.
  const longTailVisible = hasQuery || showAll;

  return (
    <div className="flex flex-col">
      <div className="px-4 pt-4 pb-3">
        <h2 className="text-sm font-medium">AI Providers & Models</h2>
        <p className="text-xs text-muted-foreground mt-0.5">
          Configure providers and enable models for use across the extension.
        </p>
      </div>

      <div className="sticky top-0 z-10 px-4 py-2 bg-background border-b border-border">
        <div className="relative">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
          <input
            ref={searchRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onFocus={() => setSearchFocused(true)}
            onBlur={() => setSearchFocused(false)}
            onKeyDown={(e) => {
              if (e.key === "Escape" && query) {
                e.preventDefault();
                e.stopPropagation();
                setQuery("");
                searchRef.current?.blur();
              }
            }}
            placeholder="Search providers and models…"
            className="w-full pl-8 pr-12 py-1.5 text-sm rounded-md border border-input bg-background focus:outline-none focus:ring-2 focus:ring-ring"
          />
          {query ? (
            <Kbd className="absolute right-2 top-1/2 -translate-y-1/2">esc</Kbd>
          ) : !searchFocused ? (
            <Kbd className="absolute right-2 top-1/2 -translate-y-1/2">/</Kbd>
          ) : null}
        </div>
      </div>

      <div className="px-4 pt-4 pb-4 flex flex-col gap-4">
        {curated.map((provider) => (
          <ProviderSection
            key={provider.id}
            provider={provider}
            settings={settings}
            onChange={onChange}
            modelStates={modelStates}
            onDownload={handleDownload}
            onDelete={handleDelete}
            query={query}
          />
        ))}

        {longTail.length > 0 && longTailVisible && (
          <>
            {!hasQuery && (
              <div className="mt-2 text-[11px] uppercase tracking-wide text-muted-foreground">
                More providers
              </div>
            )}
            {longTail.map((provider) => (
              <ProviderSection
                key={provider.id}
                provider={provider}
                settings={settings}
                onChange={onChange}
                modelStates={modelStates}
                onDownload={handleDownload}
                onDelete={handleDelete}
                query={query}
              />
            ))}
          </>
        )}

        {longTail.length > 0 && !longTailVisible && (
          <button
            type="button"
            onClick={() => setShowAll(true)}
            className="self-start text-xs text-muted-foreground hover:text-foreground underline-offset-4 hover:underline"
          >
            Show {longTail.length} more providers
          </button>
        )}

        {longTail.length > 0 && longTailVisible && !hasQuery && (
          <button
            type="button"
            onClick={() => setShowAll(false)}
            className="self-start text-xs text-muted-foreground hover:text-foreground underline-offset-4 hover:underline"
          >
            Show fewer
          </button>
        )}

        {filtered.length === 0 && hasQuery && (
          <p className="text-xs text-muted-foreground">
            No providers match &ldquo;{query}&rdquo;
          </p>
        )}
      </div>
    </div>
  );
}

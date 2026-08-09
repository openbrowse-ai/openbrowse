// src/components/memory/MemoryFileMeta.tsx
//
// Parsed-frontmatter header for a memory file, shown above the rendered body
// in the file viewer (parity with how the Skills tab surfaces a skill's
// description). A memory file's name is a slug, so the readable `title` plus a
// one-line `description` and freshness/aliases add information that's otherwise
// hidden once frontmatter is stripped from the markdown preview.
//
// Reads the parsed fields from the derived index (no extra file read), so it
// can be dropped in as `FileViewerPanel`'s `contentHeader` on any surface.

import { memoryStore, type MemoryRecord } from "@/lib/memory/store";
import { vfsEvents } from "@/lib/vfs/events";
import { useEffect, useState } from "react";

export function MemoryFileMeta({ path }: { path: string }) {
  const [meta, setMeta] = useState<MemoryRecord | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const row = await memoryStore.get(path);
      if (!cancelled) setMeta(row ?? null);
    };

    void load();

    // Frontmatter (title, description, aliases, updatedAt) changes whenever
    // the file is rewritten — by the agent in another extension context, or by
    // an edit in the viewer below — so re-read the derived index row rather
    // than let the header disagree with the body it sits above. The
    // visibility pass is a catch-up for a hidden tab that was frozen when the
    // change broadcast went out.
    const onChange = (e: Event) => {
      const detail = (e as CustomEvent<{ path?: string }>).detail;
      if (detail?.path !== path) return;
      void load();
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") void load();
    };
    vfsEvents.addEventListener("vfs:change", onChange);
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      cancelled = true;
      vfsEvents.removeEventListener("vfs:change", onChange);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [path]);

  if (!meta) return null;

  const updated = new Date(meta.updatedAt);
  const hasSubline =
    meta.aliases.length > 0 || !Number.isNaN(updated.getTime());

  return (
    <div className="mb-4 pb-4 border-b border-border">
      <h2 className="text-base font-semibold text-foreground">{meta.title}</h2>
      {meta.description && (
        <p className="text-sm text-muted-foreground mt-1">{meta.description}</p>
      )}
      {hasSubline && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-2 text-xs text-muted-foreground">
          {meta.aliases.length > 0 && (
            <span>aka {meta.aliases.join(", ")}</span>
          )}
          {!Number.isNaN(updated.getTime()) && (
            <span>Updated {updated.toISOString().slice(0, 10)}</span>
          )}
        </div>
      )}
    </div>
  );
}

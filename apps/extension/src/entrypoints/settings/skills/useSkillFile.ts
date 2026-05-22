import { useEffect, useState } from "react";
import { OPFS } from "@/lib/vfs/opfs";
import { classifyFile, isBinaryClass } from "@/lib/vfs/file-classify";

/**
 * Discriminated union representing a fetched skill file. Text and binary are
 * surfaced separately so the viewer can dispatch on `kind` without sniffing
 * the file extension a second time.
 */
export type SkillFileContent =
  | { kind: "text"; text: string }
  | { kind: "blob"; blob: Blob; blobUrl: string };

export interface UseSkillFileResult {
  content: SkillFileContent | null;
  loading: boolean;
  error: string | null;
}

function basename(p: string): string {
  return p.split("/").pop() ?? p;
}

/**
 * Fetches a skill file from OPFS and returns it as either text or a Blob URL,
 * depending on its classified extension. Re-fetches whenever `path` changes.
 *
 * Reads OPFS directly — settings is an extension page with the same OPFS
 * access as the home tab, so the previous `SKILL_READ_OPFS_FILE` background
 * relay was an unnecessary round-trip and is bypassed here.
 *
 * Pass a falsy `path` to keep the hook idle.
 */
export function useSkillFile(path: string | null | undefined): UseSkillFileResult {
  const [content, setContent] = useState<SkillFileContent | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!path) {
      setContent(null);
      setLoading(false);
      setError(null);
      return;
    }
    let cancelled = false;
    let createdUrl: string | null = null;
    setLoading(true);
    setError(null);
    setContent(null);

    const cls = classifyFile(basename(path));
    const binary = isBinaryClass(cls);

    (async () => {
      try {
        if (binary) {
          const blob = await OPFS.readFileBytes(path);
          if (cancelled) return;
          createdUrl = URL.createObjectURL(blob);
          setContent({ kind: "blob", blob, blobUrl: createdUrl });
        } else {
          const text = await OPFS.readFile(path);
          if (cancelled) return;
          setContent({ kind: "text", text });
        }
      } catch (err) {
        if (!cancelled) setError((err as Error).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
      if (createdUrl) URL.revokeObjectURL(createdUrl);
    };
  }, [path]);

  return { content, loading, error };
}

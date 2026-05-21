import { useEffect, useState } from "react";
import { sendSkillMessage } from "@/lib/skills/messages";

export interface UseSkillFileResult {
  content: string;
  loading: boolean;
  error: string | null;
}

/**
 * Fetches a skill file from OPFS and returns its content. Re-fetches whenever
 * `path` changes. Pass a falsy `path` to keep the hook idle.
 */
export function useSkillFile(path: string | null | undefined): UseSkillFileResult {
  const [content, setContent] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!path) {
      setContent("");
      setLoading(false);
      setError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    setContent("");
    sendSkillMessage({ type: "SKILL_READ_OPFS_FILE", path })
      .then((res) => {
        if (cancelled) return;
        if (res.success && res.content !== undefined) {
          setContent(res.content);
        } else {
          setError(res.error ?? "Failed to read file");
        }
      })
      .catch((err) => {
        if (!cancelled) setError(err.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [path]);

  return { content, loading, error };
}

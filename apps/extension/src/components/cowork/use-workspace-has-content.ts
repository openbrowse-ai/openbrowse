import { useEffect, useState } from "react";
import { OPFS } from "@/lib/vfs/opfs";
import { vfsEvents } from "@/lib/vfs/events";

/**
 * Cheap "does this conversation's workspace contain anything?" probe.
 * Walks `conversations/{id}/workspace` and resolves true on the first
 * entry (agent output or `.uploads/` files). Refreshes on `vfs:change`
 * for the workspace. Returns false when `conversationId` is null or the
 * workspace doesn't exist yet.
 *
 * Used to decide whether the composer's cowork bar should surface its
 * Files / Context buttons — they're only reachable once there's content.
 */
export function useWorkspaceHasContent(
  conversationId: string | null,
): boolean {
  const [hasContent, setHasContent] = useState(false);

  useEffect(() => {
    if (!conversationId) {
      setHasContent(false);
      return;
    }
    const root = `conversations/${conversationId}/workspace`;
    let mounted = true;
    // Probe runs can overlap (initial + multiple `vfs:change` events). A
    // slow earlier walk could resolve after a newer one and clobber state
    // with a stale result, so each run captures a monotonic token and only
    // commits if it's still the latest.
    let seq = 0;

    async function probe() {
      const my = ++seq;
      let found = false;
      try {
        for await (const _ of OPFS.walk(root)) {
          found = true;
          break;
        }
      } catch {
        // Workspace doesn't exist yet.
      }
      if (mounted && my === seq) setHasContent(found);
    }

    probe();
    const onVfsChange = (e: Event) => {
      const { path } = (e as CustomEvent).detail ?? {};
      if (typeof path === "string" && path.startsWith(root)) {
        probe();
      }
    };
    vfsEvents.addEventListener("vfs:change", onVfsChange);
    return () => {
      mounted = false;
      vfsEvents.removeEventListener("vfs:change", onVfsChange);
    };
  }, [conversationId]);

  return hasContent;
}

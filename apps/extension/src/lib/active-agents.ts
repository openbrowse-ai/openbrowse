import { STORAGE_KEYS } from "./constants";

export async function getActiveAgents(): Promise<string[]> {
  const result = await chrome.storage.local.get(STORAGE_KEYS.ACTIVE_AGENTS);
  return (result[STORAGE_KEYS.ACTIVE_AGENTS] as string[]) ?? [];
}

// `setAgentActive` / `setAgentInactive` are read-modify-write against
// chrome.storage.local. Multiple `useAgentChat` instances live in one page
// (the visible chat plus any hidden background scheduled-run hosts), and their
// status effects can fire near-simultaneously. Without serialization, two
// overlapping mutations read the same snapshot and the later `set` clobbers
// the earlier one — silently dropping a conversation id from the active list,
// so its sidebar "running" dot never appears (or vanishes early). Chaining all
// mutations onto a single promise queue makes each read-modify-write atomic
// within the page.
let mutationQueue: Promise<void> = Promise.resolve();

function enqueueMutation(mutate: () => Promise<void>): Promise<void> {
  const run = mutationQueue.then(mutate, mutate);
  // Keep the queue alive even if a mutation rejects.
  mutationQueue = run.then(
    () => {},
    () => {},
  );
  return run;
}

export function setAgentActive(conversationId: string): Promise<void> {
  return enqueueMutation(async () => {
    const agents = await getActiveAgents();
    if (!agents.includes(conversationId)) {
      agents.push(conversationId);
      await chrome.storage.local.set({ [STORAGE_KEYS.ACTIVE_AGENTS]: agents });
    }
  });
}

export function setAgentInactive(conversationId: string): Promise<void> {
  return enqueueMutation(async () => {
    const agents = await getActiveAgents();
    const updated = agents.filter((id) => id !== conversationId);
    await chrome.storage.local.set({ [STORAGE_KEYS.ACTIVE_AGENTS]: updated });
  });
}

/**
 * Blanket-clear the active-agents list at service-worker startup.
 *
 * Why this is correct:
 *   - The SW agent host's `agentHostRegistry` is an in-memory `Map`,
 *     wiped on every SW teardown. A fresh SW process therefore has
 *     ZERO live runs by construction.
 *   - `setAgentActive` is called when a renderer's `useChat`
 *     transitions into `streaming` / `submitted`; `setAgentInactive`
 *     fires from `useChat.onFinish` (or the status-change effect's
 *     terminal branch). The Active flag is persisted to
 *     `chrome.storage.local` so it survives renderer reloads, but
 *     that durability is what bites us when the renderer is killed
 *     before reaching the terminal branch (Chrome quit, extension
 *     reload, tab crash, OS shutdown). In all those cases the flag
 *     leaks.
 *   - Post-restart symptom: `isAgentActiveGlobally` stays `true` for
 *     the leaked conversationId, so `ChatView`'s `isLoading` is
 *     stuck `true`, the composer renders the Stop button instead of
 *     Send, and `ChatInput`'s "click while loading" path queues
 *     follow-ups instead of submitting. The Stop button itself is
 *     also inert: `useChat.stop()` has no `activeResponse` to abort,
 *     and there's no live SW handle to release.
 *
 * Calling this at SW boot, BEFORE `installAgentHost` accepts any
 * `agent-run:<conversationId>` Port, guarantees renderers attaching
 * post-boot read a clean slate. The mutation goes through the same
 * `enqueueMutation` queue as `setAgentActive` / `setAgentInactive`,
 * so a renderer that opens its first port immediately and triggers
 * `setAgentActive` for a freshly-started run can't race the reset to
 * a no-op.
 */
export function resetActiveAgentsAtStartup(): Promise<void> {
  return enqueueMutation(async () => {
    await chrome.storage.local.set({ [STORAGE_KEYS.ACTIVE_AGENTS]: [] });
  });
}

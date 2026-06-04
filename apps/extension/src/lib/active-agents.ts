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

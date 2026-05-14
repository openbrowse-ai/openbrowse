import { STORAGE_KEYS } from "./constants";

export async function getActiveAgents(): Promise<string[]> {
  const result = await chrome.storage.local.get(STORAGE_KEYS.ACTIVE_AGENTS);
  return (result[STORAGE_KEYS.ACTIVE_AGENTS] as string[]) ?? [];
}

export async function setAgentActive(conversationId: string): Promise<void> {
  const agents = await getActiveAgents();
  if (!agents.includes(conversationId)) {
    agents.push(conversationId);
    await chrome.storage.local.set({ [STORAGE_KEYS.ACTIVE_AGENTS]: agents });
  }
}

export async function setAgentInactive(conversationId: string): Promise<void> {
  const agents = await getActiveAgents();
  const updated = agents.filter((id) => id !== conversationId);
  await chrome.storage.local.set({ [STORAGE_KEYS.ACTIVE_AGENTS]: updated });
}

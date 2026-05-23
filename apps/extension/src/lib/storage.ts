import { DEFAULT_AGENT_SETTINGS, DEFAULT_SETTINGS, STORAGE_KEYS } from "./constants";
import type { AgentSettings, AutoTidyNotification, Settings, Space } from "./types";

async function get<T>(key: string): Promise<T | undefined> {
  const result = await chrome.storage.local.get(key);
  return result[key] as T | undefined;
}

async function set<T>(key: string, value: T): Promise<void> {
  await chrome.storage.local.set({ [key]: value });
}

/**
 * Serializes writes (and read-modify-write blocks) against the
 * `settings` storage key. Without this, two callers that each do a
 * `getSettings → mutate → setSettings` round-trip can lose each
 * other's updates — for example, two near-simultaneous WebLLM
 * downloads finishing and both calling `addDownloadedModel`. The
 * Promise chain enforces sequential execution; reads outside the
 * chain still observe the latest committed value because
 * `chrome.storage.local` reads are atomic.
 */
let settingsWriteChain: Promise<void> = Promise.resolve();

function lockSettings<T>(fn: () => Promise<T>): Promise<T> {
  const run = settingsWriteChain.then(fn, fn);
  // Keep the chain alive even if a caller's promise rejects.
  settingsWriteChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

export const storage = {
  async getSpaces(): Promise<Space[]> {
    const raw = (await get<any[]>(STORAGE_KEYS.SPACES)) ?? [];
    return raw.map((s) => {
      if (s.favorites) return s as Space;
      const urls: string[] = s.favoriteTabUrls ?? [];
      const titles: Record<string, string> = s.favoriteTabTitles ?? {};
      const favorites = urls.map((url: string, i: number) => ({
        url,
        title: titles[url] ?? url,
        favicon: "",
        position: i,
      }));
      const { favoriteTabUrls: _, favoriteTabTitles: _t, ...rest } = s;
      return { ...rest, favorites } as Space;
    });
  },

  async setSpaces(spaces: Space[]): Promise<void> {
    await set(STORAGE_KEYS.SPACES, spaces);
  },

  async getSpaceByWindowId(windowId: number): Promise<Space | undefined> {
    const spaces = await this.getSpaces();
    return spaces.find((s) => s.windowId === windowId);
  },

  async getSpaceByPosition(position: number): Promise<Space | undefined> {
    const spaces = await this.getSpaces();
    return spaces.find((s) => s.position === position);
  },

  async updateSpace(id: string, updates: Partial<Space>): Promise<void> {
    const spaces = await this.getSpaces();
    const idx = spaces.findIndex((s) => s.id === id);
    if (idx !== -1) {
      spaces[idx] = { ...spaces[idx], ...updates };
      await this.setSpaces(spaces);
    }
  },

  async getSettings(): Promise<Settings> {
    const stored = await get<Partial<Settings>>(STORAGE_KEYS.SETTINGS);
    return { ...DEFAULT_SETTINGS, ...stored };
  },

  async setSettings(settings: Settings): Promise<void> {
    await lockSettings(() => set(STORAGE_KEYS.SETTINGS, settings));
  },

  /**
   * Read-modify-write helper for `Settings`. Serialized against
   * `setSettings` and other `updateSettings` calls via a shared lock,
   * which prevents lost-update races between callers like
   * `addDownloadedModel` and the settings UI's auto-save paths.
   *
   * The updater receives the current persisted settings (with
   * `DEFAULT_SETTINGS` filling any missing fields) and returns the
   * next value. Returning the same reference is a valid no-op.
   */
  async updateSettings(
    updater: (current: Settings) => Settings | Promise<Settings>,
  ): Promise<Settings> {
    return lockSettings(async () => {
      const stored = await get<Partial<Settings>>(STORAGE_KEYS.SETTINGS);
      const current = { ...DEFAULT_SETTINGS, ...stored };
      const next = await updater(current);
      if (next !== current) {
        await set(STORAGE_KEYS.SETTINGS, next);
      }
      return next;
    });
  },

  async addDownloadedModel(modelId: string): Promise<void> {
    await this.updateSettings((s) => {
      if (s.downloadedModels.includes(modelId)) return s;
      return { ...s, downloadedModels: [...s.downloadedModels, modelId] };
    });
  },

  async removeDownloadedModel(modelId: string): Promise<void> {
    await this.updateSettings((s) => {
      if (!s.downloadedModels.includes(modelId)) return s;
      return {
        ...s,
        downloadedModels: s.downloadedModels.filter((m) => m !== modelId),
      };
    });
  },

  async getAgentSettings(): Promise<AgentSettings> {
    const stored = await get<Partial<AgentSettings>>(STORAGE_KEYS.AGENT_SETTINGS);
    return { ...DEFAULT_AGENT_SETTINGS, ...stored };
  },

  async setAgentSettings(settings: AgentSettings): Promise<void> {
    await set(STORAGE_KEYS.AGENT_SETTINGS, settings);
  },

  async getAutoTidyNotification(): Promise<AutoTidyNotification | null> {
    return (await get<AutoTidyNotification>(STORAGE_KEYS.AUTO_TIDY_NOTIFICATION)) ?? null;
  },

  async setAutoTidyNotification(notification: AutoTidyNotification): Promise<void> {
    await set(STORAGE_KEYS.AUTO_TIDY_NOTIFICATION, notification);
  },

  async clearAutoTidyNotification(): Promise<void> {
    await chrome.storage.local.remove(STORAGE_KEYS.AUTO_TIDY_NOTIFICATION);
  },
};

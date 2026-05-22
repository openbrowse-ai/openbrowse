import { DEFAULT_AGENT_SETTINGS, DEFAULT_SETTINGS, STORAGE_KEYS } from "./constants";
import type { AgentSettings, AutoTidyNotification, Settings, Space } from "./types";

async function get<T>(key: string): Promise<T | undefined> {
  const result = await chrome.storage.local.get(key);
  return result[key] as T | undefined;
}

async function set<T>(key: string, value: T): Promise<void> {
  await chrome.storage.local.set({ [key]: value });
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
    const stored = await get<Record<string, unknown>>(STORAGE_KEYS.SETTINGS);
    if (!stored) return { ...DEFAULT_SETTINGS };

    // Already migrated (has new fields)
    if ("providerConfigs" in stored && "enabledModels" in stored) {
      return { ...DEFAULT_SETTINGS, ...stored } as Settings;
    }

    // Migrate old format
    const migrated: Settings = { ...DEFAULT_SETTINGS };

    // General settings
    if (stored.themeMode) migrated.themeMode = stored.themeMode as Settings["themeMode"];
    if (stored.autoTidyAfterMinutes) migrated.autoTidyAfterMinutes = stored.autoTidyAfterMinutes as number;
    if (stored.agentGroupIdleHours) migrated.agentGroupIdleHours = stored.agentGroupIdleHours as number;
    if (stored.archiveAggressiveness) migrated.archiveAggressiveness = stored.archiveAggressiveness as Settings["archiveAggressiveness"];
    if (stored.mcpServers) migrated.mcpServers = stored.mcpServers as Settings["mcpServers"];

    // Migrate cloud API keys to providerConfigs
    const cloudApiKeys = (stored.cloudApiKeys || {}) as Record<string, string>;
    const singleKey = stored.cloudApiKey as string | undefined;
    const cloudProvider = stored.cloudProvider as string | undefined;

    // Store single key under its provider if cloudApiKeys doesn't have it
    if (singleKey && cloudProvider && !cloudApiKeys[cloudProvider]) {
      cloudApiKeys[cloudProvider] = singleKey;
    }

    if (cloudApiKeys.openai) migrated.providerConfigs.openai = { apiKey: cloudApiKeys.openai };
    if (cloudApiKeys.anthropic) migrated.providerConfigs.anthropic = { apiKey: cloudApiKeys.anthropic };
    if (cloudApiKeys.google) migrated.providerConfigs.google = { apiKey: cloudApiKeys.google };
    if (cloudApiKeys["openai-compatible"]) {
      migrated.providerConfigs["openai-compatible"] = {
        apiKey: cloudApiKeys["openai-compatible"],
        baseUrl: (stored.cloudBaseUrl as string) || "",
        modelId: (stored.cloudModel as string) || "",
      };
    }

    // Migrate favorite model from old single-model selection
    if (cloudProvider && stored.cloudModel && cloudProvider !== "openai-compatible") {
      migrated.favoriteModels = [`${cloudProvider}:${stored.cloudModel}`];
    }

    // Migrate downloaded models from legacy separate storage key
    const legacyDownloaded = await get<string[]>(STORAGE_KEYS.DOWNLOADED_MODELS);
    if (legacyDownloaded && legacyDownloaded.length > 0) {
      migrated.downloadedModels = legacyDownloaded;
    }

    return migrated;
  },

  async setSettings(settings: Settings): Promise<void> {
    await set(STORAGE_KEYS.SETTINGS, settings);
  },

  async getDownloadedModels(): Promise<string[]> {
    return (await get<string[]>(STORAGE_KEYS.DOWNLOADED_MODELS)) ?? [];
  },

  async addDownloadedModel(modelId: string): Promise<void> {
    const models = await this.getDownloadedModels();
    if (!models.includes(modelId)) {
      await set(STORAGE_KEYS.DOWNLOADED_MODELS, [...models, modelId]);
    }
  },

  async removeDownloadedModel(modelId: string): Promise<void> {
    const models = await this.getDownloadedModels();
    await set(
      STORAGE_KEYS.DOWNLOADED_MODELS,
      models.filter((m) => m !== modelId),
    );
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

import {
  ChatInput,
  type TabMentionAttrs,
  type ImagePreview,
  formatMentionContext,
} from "@/components/chat/ChatInput";
import {
  Suggestions,
  Suggestion,
} from "@/components/ai-elements/suggestion";
import { SpaceHeader } from "./SpaceHeader";
import { TabCard } from "./TabCard";
import { useRecentTabs } from "@/hooks/useRecentTabs";
import { chatDb } from "@/lib/chat-db";
import { storage } from "@/lib/storage";
import { DEFAULT_SETTINGS, DEFAULT_AGENT_SETTINGS } from "@/lib/constants";
import { useProviders } from "@/hooks/useProviders";
import type { Space, Settings, AgentSettings, SerializedUIPart, ThinkingConfig } from "@/lib/types";
import { useCallback, useEffect, useMemo, useState } from "react";

interface LandingPageProps {
  space: Space | null;
  spaceId: string | null;
  tabCount: number;
  pinnedCount: number;
  onNewConversation: (id: string) => void;
  /**
   * Pre-seeded value for the chat input (consumed once on mount). Used by the
   * "Try in chat" flow from settings.
   */
  initialInput?: string;
}

const SUGGESTIONS = [
  "Summarize this page",
  "What's in my tabs?",
  "Find tabs about...",
];

export function LandingPage({
  space,
  spaceId,
  tabCount,
  pinnedCount,
  onNewConversation,
  initialInput,
}: LandingPageProps) {
  const recentTabs = useRecentTabs(space?.windowId ?? null);
  const [input, setInput] = useState(initialInput ?? "");
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [agentSettings, setAgentSettings] = useState<AgentSettings>(DEFAULT_AGENT_SETTINGS);

  const updateSettings = useCallback((patch: Partial<Settings>) => {
    setSettings((prev) => {
      const next = { ...prev, ...patch };
      storage.setSettings(next);
      return next;
    });
  }, []);

  const { providers } = useProviders();

  useEffect(() => {
    storage.getSettings().then(setSettings);
    storage.getAgentSettings().then(setAgentSettings);
    const listener = (
      changes: Record<string, chrome.storage.StorageChange>,
      area: string,
    ) => {
      if (area === "local") {
        if (changes.settings) storage.getSettings().then(setSettings);
        if (changes["agent-settings"])
          storage.getAgentSettings().then(setAgentSettings);
      }
    };
    chrome.storage.onChanged.addListener(listener);
    return () => chrome.storage.onChanged.removeListener(listener);
  }, []);

  const providerModels = useMemo(() => {
    return providers
      .map((provider) => {
        let enabled = true;
        let availableModels = provider.models;

        if (provider.setup === "byok") {
          const config = settings.providerConfigs[provider.id] ?? {};
          const requiredFields = provider.configSchema?.filter((f) => f.required) ?? [];
          enabled = requiredFields.every((f) => !!config[f.key]);
          if (!enabled) return null;
        } else if (provider.setup === "web-llm" || provider.setup === "browser-ai") {
          availableModels = provider.models.filter((m) => settings.downloadedModels.includes(m.id));
          enabled = availableModels.length > 0;
          if (!enabled) return null;
        }

        return {
          provider: provider.id,
          label: provider.name,
          models: availableModels,
          enabled,
        };
      })
      .filter((p): p is NonNullable<typeof p> => p !== null);
  }, [providers, settings.providerConfigs, settings.downloadedModels]);

  const isConfigured = useMemo(() => {
    if (!agentSettings.agentModel) return false;
    const [providerId, ...modelIdParts] = agentSettings.agentModel.split(":");
    const actualModelId = modelIdParts.length > 0 ? modelIdParts.join(":") : agentSettings.agentModel;
    
    return providerModels.some((p) => {
      if (modelIdParts.length > 0 && p.provider !== providerId) return false;
      return p.models.some((m) => m.id === actualModelId);
    });
  }, [providerModels, agentSettings.agentModel]);

  const handleSubmit = useCallback(
    async (mentions: TabMentionAttrs[], images: ImagePreview[]) => {
      if (!input.trim() && images.length === 0) return;

      const convId = crypto.randomUUID();
      await chatDb.createConversation({
        id: convId,
        title: input.trim().slice(0, 100) || "Image",
        spaceId,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });

      const baseText = input.trim();
      const mentionContext = await formatMentionContext(mentions);
      const fullText = baseText + mentionContext;

      const fileParts: SerializedUIPart[] = images.map((img) => ({
        type: "file" as const,
        mediaType: img.file.type,
        url: img.dataUrl,
      }));

      await chatDb.saveMessage({
        id: crypto.randomUUID(),
        conversationId: convId,
        role: "user",
        content: fullText,
        parts: [
          ...(fullText ? [{ type: "text" as const, text: fullText }] : []),
          ...fileParts,
        ],
        createdAt: Date.now(),
      });

      // Generate a real chat title via the agent provider. The conversation
      // title currently holds the truncated raw user input; this upgrades it
      // to a short AI-generated label, matching useAgentChat's behavior for
      // side-panel-started chats. The async result also feeds the tab-group
      // labeler when navigate fires later.
      if (baseText) {
        const provider = providers.find((p) =>
          p.models.some((m) => m.id === agentSettings.agentModel),
        );
        if (provider) {
          const config = settings.providerConfigs[provider.id] ?? {};
          window.dispatchEvent(
            new CustomEvent("chat-title-generating", { detail: { id: convId } }),
          );
          chrome.runtime
            .sendMessage({
              type: "GENERATE_CHAT_TITLE",
              providerId: provider.id,
              config,
              modelId: agentSettings.agentModel,
              userMessage: baseText,
            })
            .then((res: { title?: string } | undefined) => {
              if (res?.title) {
                chatDb.updateConversation(convId, { title: res.title });
              }
              window.dispatchEvent(
                new CustomEvent("chat-title-updated", {
                  detail: { id: convId, title: res?.title },
                }),
              );
            })
            .catch(() => {
              window.dispatchEvent(
                new CustomEvent("chat-title-updated", { detail: { id: convId } }),
              );
            });
        }
      }

      setInput("");
      onNewConversation(convId);
    },
    [
      input,
      spaceId,
      onNewConversation,
      agentSettings.agentModel,
      settings.providerConfigs,
    ],
  );

  const handleSuggestion = useCallback((text: string) => {
    setInput(text);
  }, []);

  const handleTabCardClick = useCallback(
    (tab: { title: string; url: string }) => {
      setInput((prev: string) =>
        prev ? `${prev} ${tab.title}` : `Tell me about ${tab.title}`,
      );
    },
    [],
  );

  return (
    <div className="flex flex-col items-center justify-center min-h-screen px-6 py-12">
      <div className="w-full max-w-xl flex flex-col items-center gap-8">
        {space && (
          <SpaceHeader
            space={space}
            tabCount={tabCount}
            pinnedCount={pinnedCount}
          />
        )}

        {/* Hero chat input */}
        <div className="w-full">
          <ChatInput
            value={input}
            onChange={setInput}
            onSubmit={handleSubmit}
            isLoading={false}
            disabled={!isConfigured}
            autoFocus
            providerModels={providerModels}
            favoriteModels={settings.favoriteModels}
            onFavoriteToggle={(modelKey) => {
              const favoriteModels = settings.favoriteModels.includes(modelKey)
                ? settings.favoriteModels.filter((k) => k !== modelKey)
                : [...settings.favoriteModels, modelKey];
              updateSettings({ favoriteModels });
            }}
            selectedModel={agentSettings.agentModel}
            onModelChange={(modelId) => {
              const updated = { ...agentSettings, agentModel: modelId };
              setAgentSettings(updated);
              storage.setAgentSettings(updated);
            }}
            thinkingEnabled={agentSettings.thinkingEnabled}
            thinkingConfig={agentSettings.thinkingConfig}
            onThinkingChange={(enabled, config) => {
              const updated = {
                ...agentSettings,
                thinkingEnabled: enabled,
                thinkingConfig: config ?? agentSettings.thinkingConfig,
              };
              setAgentSettings(updated);
              storage.setAgentSettings(updated);
            }}
            selectedModelCapabilities={
              providers
                .flatMap((p) => p.models)
                .find((m) => {
                  const parts = agentSettings.agentModel.split(":");
                  const actualId = parts.length > 1 ? parts.slice(1).join(":") : agentSettings.agentModel;
                  return m.id === actualId;
                })
                ?.capabilities
            }
          />
          {!isConfigured && (
            <button
              type="button"
              onClick={() => chrome.tabs.create({ url: chrome.runtime.getURL("/settings.html") })}
              className="mt-2 w-full text-center text-xs text-primary hover:underline"
            >
              Set up an AI model to get started
            </button>
          )}
        </div>

        {/* Suggestion buttons */}
        {isConfigured && (
          <Suggestions>
            {SUGGESTIONS.map((s) => (
              <Suggestion key={s} suggestion={s} onClick={handleSuggestion} />
            ))}
          </Suggestions>
        )}

        {/* Recent tab cards */}
        {recentTabs.length > 0 && (
          <div className="w-full">
            <h2 className="text-xs font-medium text-muted-foreground mb-2">
              Recent tabs
            </h2>
            <div className="flex flex-wrap gap-2">
              {recentTabs.map((tab) => (
                <TabCard
                  key={tab.id}
                  title={tab.title}
                  url={tab.url}
                  favicon={tab.favicon}
                  onClick={() => handleTabCardClick(tab)}
                />
              ))}
            </div>
          </div>
        )}

      </div>
    </div>
  );
}

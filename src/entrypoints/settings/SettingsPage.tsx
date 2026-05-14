import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { X } from "lucide-react";
import { useHotkeys } from "react-hotkeys-hook";
import { useTheme } from "@/hooks/useTheme";
import { DEFAULT_SETTINGS, DEFAULT_AGENT_SETTINGS } from "@/lib/constants";
import { storage } from "@/lib/storage";
import type { Settings, AgentSettings } from "@/lib/types";
import { GeneralTab } from "./GeneralTab";
import { ModelsTab } from "./ModelsTab";
import { ConnectorsTab } from "./ConnectorsTab";
import { SpacesTab } from "./SpacesTab";
import { MemoryTab } from "./MemoryTab";

const TABS = [
  { id: "general", label: "General" },
  { id: "spaces", label: "Spaces" },
  { id: "models", label: "Models" },
  { id: "connectors", label: "Connectors" },
  { id: "memory", label: "Memory" },
] as const;

type TabId = (typeof TABS)[number]["id"];

interface SettingsPageProps {
  onBack: () => void;
}

export function SettingsPage({ onBack }: SettingsPageProps) {
  useTheme();
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [savedSettings, setSavedSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [agentSettings, setAgentSettings] = useState<AgentSettings>(DEFAULT_AGENT_SETTINGS);
  const [savedAgentSettings, setSavedAgentSettings] = useState<AgentSettings>(DEFAULT_AGENT_SETTINGS);
  const [activeTab, setActiveTab] = useState<TabId>("general");

  const dirty = JSON.stringify(settings) !== JSON.stringify(savedSettings) ||
                JSON.stringify(agentSettings) !== JSON.stringify(savedAgentSettings);

  useEffect(() => {
    storage.getSettings().then((s) => {
      setSettings(s);
      setSavedSettings(s);
    });
    storage.getAgentSettings().then((a) => {
      setAgentSettings(a);
      setSavedAgentSettings(a);
    });
  }, []);

  const updateSettings = useCallback((patch: Partial<Settings>) => {
    setSettings((prev) => ({ ...prev, ...patch }));
  }, []);

  const handleSave = useCallback(async () => {
    await storage.setSettings(settings);
    setSavedSettings(settings);
    await storage.setAgentSettings(agentSettings);
    setSavedAgentSettings(agentSettings);

    // Auto-select first enabled model if none is currently selected
    if (settings.enabledModels.length > 0 && !agentSettings.agentModel) {
      const firstModelId = settings.enabledModels[0].split(":").slice(1).join(":");
      const updatedAgentSettings = { ...agentSettings, agentModel: firstModelId };
      await storage.setAgentSettings(updatedAgentSettings);
      setAgentSettings(updatedAgentSettings);
      setSavedAgentSettings(updatedAgentSettings);
    }
  }, [settings, agentSettings]);

  const handleRevert = useCallback(() => {
    setSettings(savedSettings);
    setAgentSettings(savedAgentSettings);
  }, [savedSettings, savedAgentSettings]);

  useHotkeys(
    "mod+s",
    (e) => {
      e.preventDefault();
      if (dirty) handleSave();
    },
    { enableOnFormTags: true },
    [dirty, handleSave],
  );
  useHotkeys("escape", () => onBack(), { enableOnFormTags: true }, [onBack]);

  return (
    <div className="h-screen flex flex-col bg-background text-foreground overflow-hidden">
      {/* Header */}
      <div className="sticky top-0 z-50 flex items-center justify-between border-b border-border bg-muted px-4 py-2 shrink-0">
        <div className="flex items-center gap-2">
          <a
            href="/home.html"
            className="flex items-center hover:opacity-80 transition-opacity"
          >
            <img src="/icon/logo.svg" alt="OpenBrowse" className="h-4 w-4 dark:hidden" />
            <img src="/icon/logo-dark.svg" alt="OpenBrowse" className="h-4 w-4 hidden dark:block" />
          </a>
          <span className="text-muted-foreground text-sm">/</span>
          <h1 className="text-sm font-semibold">Settings</h1>
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          onClick={onBack}
        >
          <X className="h-4 w-4" />
        </Button>
      </div>

      {/* Sidebar + Content */}
      <div className="flex flex-1 min-h-0">
        {/* Sidebar navigation */}
        <nav className="w-36 shrink-0 border-r border-border py-2 px-2 space-y-0.5">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`w-full text-left px-3 py-1.5 rounded-sm text-sm transition-colors ${
                activeTab === tab.id
                  ? "bg-accent text-accent-foreground font-medium"
                  : "text-muted-foreground hover:text-foreground hover:bg-accent/50"
              }`}
            >
              {tab.label}
            </button>
          ))}
        </nav>

        {/* Content area */}
        <div className="flex-1 overflow-y-auto p-4">
          {activeTab === "general" && (
            <GeneralTab
              settings={settings}
              onChange={updateSettings}
              agentSettings={agentSettings}
              onAgentSettingsChange={(patch) => {
                setAgentSettings((prev) => ({ ...prev, ...patch }));
              }}
            />
          )}
          {activeTab === "spaces" && <SpacesTab />}
          {activeTab === "models" && (
            <ModelsTab settings={settings} onChange={async (patch) => {
              const updated = { ...settings, ...patch };
              setSettings(updated);
              if (patch.providerConfigs) {
                setSavedSettings(updated);
                await storage.setSettings(updated);
              }
            }} />
          )}
          {activeTab === "connectors" && (
            <ConnectorsTab
              settings={settings}
              onChange={async (patch) => {
                const updated = { ...settings, ...patch };
                setSettings(updated);
                setSavedSettings(updated);
                // Read fresh from storage to avoid overwriting auth data written by background script
                const current = await storage.getSettings();
                if (patch.mcpServers) {
                  const merged = patch.mcpServers.map((s) => {
                    const existing = current.mcpServers.find((e) => e.id === s.id);
                    return existing ? { ...existing, ...s } : s;
                  });
                  await storage.setSettings({ ...current, mcpServers: merged });
                } else {
                  await storage.setSettings({ ...current, ...patch });
                }
              }}
            />
          )}
          {activeTab === "memory" && <MemoryTab />}
        </div>
      </div>

      {/* Floating dirty bar */}
      <div
        className={`fixed left-1/2 -translate-x-1/2 z-40 border border-border bg-background/95 backdrop-blur-sm px-4 py-2 rounded-md flex items-center gap-4 transition-all duration-200 ease-out ${
          dirty
            ? "bottom-4 opacity-100 scale-100"
            : "bottom-0 opacity-0 scale-95 pointer-events-none"
        }`}
      >
        <span className="text-sm text-muted-foreground">Unsaved changes</span>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={handleRevert}>
            Revert
          </Button>
          <Button size="sm" onClick={handleSave}>
            Save <Kbd className="ml-1.5">⌘S</Kbd>
          </Button>
        </div>
      </div>
    </div>
  );
}

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { X } from "lucide-react";
import { useHotkeys } from "react-hotkeys-hook";
import { useTheme } from "@/hooks/useTheme";
import { DEFAULT_SETTINGS, DEFAULT_AGENT_SETTINGS } from "@/lib/constants";
import { storage } from "@/lib/storage";
import type { Settings, AgentSettings } from "@/lib/types";
import { GeneralTab } from "./GeneralTab";
import { MemoryTab } from "./MemoryTab";
import { ModelsTab } from "./ModelsTab";
import { SkillsTab } from "./SkillsTab";
import { ConnectorsTab } from "./ConnectorsTab";
import { McpBridgeTab } from "./mcp-bridge";
import {
  formatSettingsSearch,
  parseSettingsTab,
  type SettingsTabId,
} from "./route";

const TABS: ReadonlyArray<{ id: SettingsTabId; label: string }> = [
  { id: "general", label: "General" },
  { id: "models", label: "Models" },
  { id: "connectors", label: "Connectors" },
  { id: "skills", label: "Skills" },
  { id: "memory", label: "Memory" },
  { id: "mcp-bridge", label: "MCP Server" },
] as const;

type TabId = SettingsTabId;

interface SettingsPageProps {
  onBack: () => void;
}

export function SettingsPage({ onBack }: SettingsPageProps) {
  useTheme();
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [savedSettings, setSavedSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [agentSettings, setAgentSettings] = useState<AgentSettings>(DEFAULT_AGENT_SETTINGS);
  const [savedAgentSettings, setSavedAgentSettings] = useState<AgentSettings>(DEFAULT_AGENT_SETTINGS);
  
  // Active tab is URL-backed via `?tab=<id>`. Reading from the query
  // string on mount lets external callers (e.g. `openSettingsTab("models")`)
  // deep-link, and writing back via `pushState` on tab change makes the
  // tab survive reload and Back/Forward navigation.
  const [activeTab, setActiveTabState] = useState<TabId>(() =>
    parseSettingsTab(window.location.search),
  );

  // Track the most recent search string we wrote so the URL→state
  // listener (popstate) can ignore self-induced changes.
  const lastWrittenSearchRef = useRef<string>(window.location.search);

  const setActiveTab = useCallback((next: TabId) => {
    setActiveTabState(next);
    const nextSearch = formatSettingsSearch(next, window.location.search);
    if (nextSearch !== window.location.search) {
      const url =
        window.location.pathname + nextSearch + window.location.hash;
      history.pushState(null, "", url);
      lastWrittenSearchRef.current = nextSearch;
    }
  }, []);

  // popstate (Back/Forward) → reflect into state. Ignore the event when
  // the current search matches what we just wrote.
  useEffect(() => {
    function onPopState() {
      if (window.location.search === lastWrittenSearchRef.current) return;
      lastWrittenSearchRef.current = window.location.search;
      setActiveTabState(parseSettingsTab(window.location.search));
    }
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

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

    // Auto-select first favorite model if none is currently selected
    if (settings.favoriteModels.length > 0 && !agentSettings.agentModel) {
      const firstModelId = settings.favoriteModels[0].split(":").slice(1).join(":");
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

  useEffect(() => {
    function handleKeydown(e: KeyboardEvent) {
      if (e.altKey && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
        const digitMatch = e.code.match(/^Digit([1-9])$/);
        if (digitMatch) {
          e.preventDefault();
          chrome.runtime.sendMessage({
            type: "SWITCH_SPACE_BY_POSITION",
            position: parseInt(digitMatch[1], 10),
          });
        }
      }
    }
    document.addEventListener("keydown", handleKeydown, true);
    return () => document.removeEventListener("keydown", handleKeydown, true);
  }, []);

  return (
    <div className="h-screen flex flex-col bg-background text-foreground overflow-hidden">
      {/* Header */}
      <div className="sticky top-0 z-50 flex items-center justify-between border-b border-border bg-muted px-4 py-2 shrink-0">
        <div className="flex items-center gap-2">
          <span className="flex items-center">
            <img src="/icon/logo.svg" alt="OpenBrowse" className="h-4 w-4 dark:hidden" />
            <img src="/icon/logo-dark.svg" alt="OpenBrowse" className="h-4 w-4 hidden dark:block" />
          </span>
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
        <div className="flex-1 overflow-y-auto">
          {activeTab === "general" && (
            <div className="p-4">
              <GeneralTab
                settings={settings}
                onChange={updateSettings}
                agentSettings={agentSettings}
                onAgentSettingsChange={(patch) => {
                  setAgentSettings((prev) => ({ ...prev, ...patch }));
                }}
              />
            </div>
          )}
          {activeTab === "models" && (
            <ModelsTab settings={settings} onChange={async (patch) => {
              // Model download/delete persists `downloadedModels` immediately
              // (the background writes storage via add/removeDownloadedModel).
              // Reconcile it into BOTH working and saved state so it never
              // registers as an unsaved change, without disturbing other
              // in-flight field edits.
              if (patch.downloadedModels) {
                const next = patch.downloadedModels;
                setSettings((prev) => ({ ...prev, downloadedModels: next }));
                setSavedSettings((prev) => ({ ...prev, downloadedModels: next }));
                return;
              }
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

          {activeTab === "skills" && (
            <SkillsTab
              settings={settings}
              onChange={async (patch) => {
                const updated = { ...settings, ...patch };
                setSettings(updated);
                setSavedSettings(updated);
                await storage.setSettings(updated);
              }}
            />
          )}
          {activeTab === "memory" && (
            <div className="p-4">
              <MemoryTab />
            </div>
          )}
          {activeTab === "mcp-bridge" && (
            <div className="p-4">
              <McpBridgeTab />
            </div>
          )}
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

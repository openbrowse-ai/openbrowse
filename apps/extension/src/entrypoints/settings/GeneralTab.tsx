import { ExternalLink } from "lucide-react";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import type { Settings, AgentSettings } from "@/lib/types";
import { useProviders } from "@/hooks/useProviders";
import { RegistryIcon } from "@/components/ui/registry-icon";

interface GeneralTabProps {
  settings: Settings;
  onChange: (patch: Partial<Settings>) => void;
  agentSettings: AgentSettings;
  onAgentSettingsChange: (patch: Partial<AgentSettings>) => void;
}

export function GeneralTab({ settings, onChange, agentSettings, onAgentSettingsChange }: GeneralTabProps) {
  const { providers } = useProviders();
  const enabledModelOptions = settings.favoriteModels.map((m) => {
    const [providerId, ...rest] = m.split(":");
    const modelId = rest.join(":");
    const provider = providers.find((p) => p.id === providerId);
    const model = provider?.models.find((md) => md.id === modelId);
    return { value: m, label: model?.name ?? m, providerId: provider?.id };
  });

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <Label>Theme</Label>
        <Select
          value={settings.themeMode}
          onValueChange={(v) =>
            onChange({ themeMode: v as Settings["themeMode"] })
          }
        >
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="system">System</SelectItem>
            <SelectItem value="light">Light</SelectItem>
            <SelectItem value="dark">Dark</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-2">
        <Label>Auto-tidy after (hours)</Label>
        <Input
          type="number"
          min={1}
          value={settings.autoTidyAfterMinutes / 60}
          onChange={(e) =>
            onChange({ autoTidyAfterMinutes: Number(e.target.value) * 60 })
          }
        />
      </div>

      <div className="space-y-2">
        <Label>Archive aggressiveness</Label>
        <Select
          value={settings.archiveAggressiveness}
          onValueChange={(v) =>
            onChange({
              archiveAggressiveness: v as Settings["archiveAggressiveness"],
            })
          }
        >
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="low">Low</SelectItem>
            <SelectItem value="medium">Medium</SelectItem>
            <SelectItem value="high">High</SelectItem>
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">
          {settings.archiveAggressiveness === "low" &&
            "Only archives junk — error pages, blank tabs, and exact duplicates."}
          {settings.archiveAggressiveness === "medium" &&
            "Also archives outdated, redundant, and transient tabs like search results or login redirects."}
          {settings.archiveAggressiveness === "high" &&
            "Aggressively cleans up anything unlikely to be needed again. When in doubt, it archives."}
        </p>
      </div>

      <div className="flex items-center justify-between">
        <div className="space-y-0.5">
          <Label>Agent notifications</Label>
          <p className="text-xs text-muted-foreground">
            Show desktop notifications when the agent finishes or needs approval
          </p>
        </div>
        <Switch
          checked={settings.notificationsEnabled}
          onCheckedChange={(checked) => onChange({ notificationsEnabled: checked })}
        />
      </div>

      <div className="space-y-2">
        <Label>Tidy model</Label>
        <Select
          value={settings.tidyModel || undefined}
          onValueChange={(v) => onChange({ tidyModel: v })}
        >
          <SelectTrigger>
            <SelectValue placeholder="Select a model for tidy" />
          </SelectTrigger>
          <SelectContent>
            {enabledModelOptions.length === 0 ? (
              <p className="px-2 py-1.5 text-sm text-muted-foreground">
                Enable models in the Models tab first
              </p>
            ) : (
              enabledModelOptions.map((opt) => (
                <SelectItem key={opt.value} value={opt.value}>
                  <span className="flex items-center gap-2">
                    {opt.providerId && <RegistryIcon id={opt.providerId} className="size-4" />}
                    {opt.label}
                  </span>
                </SelectItem>
              ))
            )}
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">
          Model used for automatic tab tidying
        </p>
      </div>

      <div className="space-y-2">
        <Label>Compaction Model</Label>
        <p className="text-xs text-muted-foreground">
          Model used for summarizing conversation history when context limit is reached. Defaults to agent model.
        </p>
        <Select
          value={agentSettings.compactionModel || "__default__"}
          onValueChange={(v) => onAgentSettingsChange({ compactionModel: v === "__default__" ? undefined : v })}
        >
          <SelectTrigger>
            <SelectValue placeholder="Same as agent model" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__default__">Same as agent model</SelectItem>
            {enabledModelOptions.map((opt) => (
              <SelectItem key={opt.value} value={opt.value}>
                <span className="flex items-center gap-2">
                  {opt.providerId && <RegistryIcon id={opt.providerId} className="size-4" />}
                  {opt.label}
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-4 pt-4 border-t">
        <h3 className="text-sm font-medium">Keyboard Shortcuts</h3>
        <p className="text-xs text-muted-foreground">
          OpenBrowse ships with two AI chat shortcuts:
        </p>
        <ul className="list-disc list-inside text-xs text-muted-foreground space-y-1">
          <li>
            <strong>Alt + I</strong> (Option + I on Mac) — toggles the chat in the
            current tab&apos;s side panel.
          </li>
          <li>
            <strong>Alt + Space</strong> (Option + Space on Mac) — opens the chat
            in a standalone popup window.
          </li>
        </ul>
        <div className="bg-secondary/50 p-4 rounded-md border text-sm">
          <p className="font-medium mb-2">Want to launch the popup from anywhere on your computer (even when Chrome isn&apos;t focused)?</p>
          <ol className="list-decimal list-inside space-y-1 mb-3 text-muted-foreground text-xs">
            <li>Click the link below to open Chrome&apos;s shortcut settings</li>
            <li>Find the <strong>&quot;Open Global AI chat popup&quot;</strong> shortcut</li>
            <li>Change the dropdown from <strong>&quot;In Chrome&quot;</strong> to <strong>&quot;Global&quot;</strong></li>
          </ol>
          <a
            href="chrome://extensions/shortcuts"
            onClick={(e) => {
              e.preventDefault();
              chrome.tabs.create({ url: "chrome://extensions/shortcuts" });
            }}
            className="inline-flex items-center text-primary hover:underline font-medium text-xs cursor-pointer"
          >
            Open Chrome Shortcut Settings
            <ExternalLink className="ml-1 h-3 w-3" />
          </a>
        </div>
      </div>
    </div>
  );
}

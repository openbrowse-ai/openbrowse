import React, { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useSkillsState } from "@/hooks/useSkillsState";
import { getSkillsRegistry } from "@/lib/skills/registry";
import { Plus, Trash2, Github, BookOpen } from "lucide-react";

export function SkillsTab({ settings, onChange }: { settings: any; onChange: (patch: any) => void }) {
  const { skills } = useSkillsState();
  const [selectedSkill, setSelectedSkill] = useState<string | null>(null);
  const [installSource, setInstallSource] = useState("");
  const [isInstalling, setIsInstalling] = useState(false);
  const [error, setError] = useState("");

  const activeSkill = skills.find((s) => s.name === selectedSkill);

  const handleInstall = async () => {
    if (!installSource.trim()) return;
    setIsInstalling(true);
    setError("");
    try {
      await getSkillsRegistry().install(installSource, settings.githubToken);
      setInstallSource("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setIsInstalling(false);
    }
  };

  const handleUninstall = async (name: string) => {
    if (confirm(`Uninstall ${name}?`)) {
      await getSkillsRegistry().uninstall(name);
      if (selectedSkill === name) setSelectedSkill(null);
    }
  };

  return (
    <div className="flex h-full min-h-[500px]">
      {/* Left Pane - List */}
      <div className="w-1/3 border-r pr-4 flex flex-col gap-4">
        <div>
          <h2 className="text-lg font-medium mb-4">Installed Skills</h2>
          <div className="flex flex-col gap-2">
            {skills.map((skill) => (
              <button
                key={skill.name}
                onClick={() => setSelectedSkill(skill.name)}
                className={`p-3 text-left rounded-md border transition-colors ${
                  selectedSkill === skill.name
                    ? "border-primary bg-primary/5"
                    : "border-border hover:bg-muted"
                }`}
              >
                <div className="font-medium text-sm">{skill.name}</div>
                <div className="text-xs text-muted-foreground line-clamp-1 mt-1">
                  {skill.description}
                </div>
              </button>
            ))}
            {skills.length === 0 && (
              <div className="text-sm text-muted-foreground italic py-4">
                No skills installed yet.
              </div>
            )}
          </div>
        </div>

        <div className="mt-auto pt-4 border-t">
          <div className="text-sm font-medium mb-2">Install New Skill</div>
          <div className="flex gap-2">
            <Input
              placeholder="github:owner/repo"
              value={installSource}
              onChange={(e) => setInstallSource(e.target.value)}
              className="flex-1 text-sm"
              onKeyDown={(e) => {
                if (e.key === "Enter") handleInstall();
              }}
            />
            <Button
              size="sm"
              disabled={!installSource.trim() || isInstalling}
              onClick={handleInstall}
            >
              {isInstalling ? "Installing..." : <Plus className="w-4 h-4" />}
            </Button>
          </div>
          {error && <div className="text-xs text-destructive mt-2">{error}</div>}
        </div>
      </div>

      {/* Right Pane - Detail */}
      <div className="flex-1 pl-6 overflow-y-auto">
        {activeSkill ? (
          <div className="flex flex-col gap-6">
            <div className="flex justify-between items-start">
              <div>
                <h1 className="text-2xl font-semibold">{activeSkill.name}</h1>
                <div className="text-sm text-muted-foreground mt-1">
                  Source: {activeSkill.source}
                </div>
              </div>
              <Button
                variant="destructive"
                size="sm"
                onClick={() => handleUninstall(activeSkill.name)}
              >
                <Trash2 className="w-4 h-4 mr-2" />
                Uninstall
              </Button>
            </div>

            <div className="text-sm">{activeSkill.description}</div>

            {activeSkill.hasScripts && (
              <div className="bg-amber-500/10 text-amber-500 border border-amber-500/20 rounded-md p-3 text-sm">
                <strong>Contains Scripts:</strong> This skill includes executable scripts ({activeSkill.scriptTypes.join(", ")}). OpenBrowse runs in the browser and cannot execute these scripts. The agent will read them for context instead.
              </div>
            )}

            <div>
              <h3 className="text-sm font-medium border-b pb-2 mb-3">Files in OPFS</h3>
              <ul className="text-sm text-muted-foreground space-y-1">
                {activeSkill.fileIndex.map((file) => (
                  <li key={file} className="flex items-center gap-2">
                    <BookOpen className="w-3 h-3" />
                    {file}
                  </li>
                ))}
              </ul>
            </div>
            
            <div className="text-xs text-muted-foreground pt-4 border-t">
              Installed on {new Date(activeSkill.installedAt).toLocaleString()}
            </div>
          </div>
        ) : (
          <div className="h-full flex items-center justify-center text-muted-foreground text-sm">
            Select a skill to view details or install a new one.
          </div>
        )}
      </div>
    </div>
  );
}

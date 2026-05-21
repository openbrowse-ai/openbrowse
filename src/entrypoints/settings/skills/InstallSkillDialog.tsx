import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { getSkillsRegistry } from "@/lib/skills/registry";
import { useState } from "react";
import { toast } from "sonner";

interface InstallSkillDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  githubToken?: string;
}

export function InstallSkillDialog({
  open,
  onOpenChange,
  githubToken,
}: InstallSkillDialogProps) {
  const [source, setSource] = useState("");
  const [specificSkill, setSpecificSkill] = useState("");
  const [isInstalling, setIsInstalling] = useState(false);

  const handleInstall = async () => {
    if (!source.trim()) return;
    setIsInstalling(true);
    try {
      const res = await getSkillsRegistry().install(
        source.trim(),
        githubToken,
        specificSkill.trim() || undefined,
      );
      if (res.installed.length === 0) {
        toast.error("No skills found in that source");
      } else {
        toast.success(
          `Installed ${res.installed.length} skill${res.installed.length > 1 ? "s" : ""}`,
        );
        setSource("");
        setSpecificSkill("");
        onOpenChange(false);
      }
    } catch (e) {
      toast.error(`Install failed: ${(e as Error).message}`);
    } finally {
      setIsInstalling(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Install skill from URL</DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-4">
          <div className="space-y-2">
            <label className="text-sm font-medium">Source</label>
            <Input
              placeholder="owner/repo or https://github.com/owner/repo"
              value={source}
              onChange={(e) => setSource(e.target.value)}
              autoFocus
              onKeyDown={(e) => {
                if (e.key === "Enter") handleInstall();
              }}
            />
            <p className="text-xs text-muted-foreground">
              Supports GitHub repos containing one or more skills (e.g.{" "}
              <code className="text-foreground">anthropics/skills</code>
              ).
            </p>
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium text-muted-foreground">
              Specific skill to install (optional)
            </label>
            <Input
              placeholder="e.g. skill-creator"
              value={specificSkill}
              onChange={(e) => setSpecificSkill(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleInstall();
              }}
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={handleInstall}
            disabled={!source.trim() || isInstalling}
          >
            {isInstalling ? "Installing..." : "Install"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

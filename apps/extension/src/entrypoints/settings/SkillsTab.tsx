import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Switch } from "@/components/ui/switch";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { downloadBlob, downloadText } from "@/lib/download";
import { useSkillsState } from "@/hooks/useSkillsState";
import { getSkillsRegistry } from "@/lib/skills/registry";
import type { InstalledSkill } from "@/lib/skills/types";
import {
  Check,
  ChevronDown,
  Code as CodeIcon,
  Copy,
  Download,
  ExternalLink,
  Eye,
  Info,
  MessageSquare,
  MoreHorizontal,
  Plus,
  Search,
  Trash2,
  Upload,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { InstallSkillDialog } from "./skills/InstallSkillDialog";
import { SkillFileTree } from "./skills/SkillFileTree";
import {
  SkillFileViewer,
  type SkillFileViewMode,
} from "./skills/SkillFileViewer";
import { UploadSkillDialog } from "./skills/UploadSkillDialog";
import { addedByForSkill, parseSkillSource } from "./skills/source";
import { useSkillFile } from "./skills/useSkillFile";

export function SkillsTab({
  settings,
}: {
  settings: any;
  onChange: (patch: any) => void;
}) {
  const { skills } = useSkillsState();
  const [selectedSkillName, setSelectedSkillName] = useState<string | null>(
    null,
  );
  const [selectedFilePath, setSelectedFilePath] = useState<string | null>(null);
  const [installOpen, setInstallOpen] = useState(false);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [confirmUninstall, setConfirmUninstall] = useState<string | null>(null);

  // Mode toggle for whichever file is currently rendered (active skill's
  // SKILL.md card preview in Mode A, or the selected file in Mode B). Tracked
  // here so it persists across renders.
  const [skillCardMode, setSkillCardMode] =
    useState<SkillFileViewMode>("preview");
  const [fileMode, setFileMode] = useState<SkillFileViewMode>("preview");
  const [copied, setCopied] = useState(false);

  // Auto-select first skill on load
  useEffect(() => {
    if (selectedSkillName === null && skills.length > 0) {
      setSelectedSkillName(skills[0].name);
    }
  }, [skills, selectedSkillName]);

  const activeSkill = useMemo(
    () => skills.find((s) => s.name === selectedSkillName) ?? null,
    [skills, selectedSkillName],
  );

  const { personalSkills, builtInSkills } = useMemo(() => {
    const filter = (s: InstalledSkill) => {
      if (!searchQuery.trim()) return true;
      const q = searchQuery.toLowerCase();
      return (
        s.name.toLowerCase().includes(q) ||
        s.description.toLowerCase().includes(q)
      );
    };
    return {
      personalSkills: skills
        .filter((s) => s.source !== "bundled")
        .filter(filter),
      builtInSkills: skills
        .filter((s) => s.source === "bundled")
        .filter(filter),
    };
  }, [skills, searchQuery]);

  const handleSelectSkill = (name: string) => {
    if (selectedSkillName === name) {
      // Re-clicking the active skill clears any file selection so the user
      // returns to Mode A (skill detail view).
      setSelectedFilePath(null);
      return;
    }
    setSelectedSkillName(name);
    setSelectedFilePath(null);
    setSkillCardMode("preview");
  };

  const handleSelectFile = (relativePath: string) => {
    setSelectedFilePath(relativePath);
    setFileMode(
      relativePath.toLowerCase().endsWith(".md") ? "preview" : "code",
    );
  };

  const handleUninstall = async (name: string) => {
    try {
      await getSkillsRegistry().uninstall(name);
      toast.success(`Uninstalled "${name}"`);
      if (selectedSkillName === name) {
        setSelectedSkillName(null);
        setSelectedFilePath(null);
      }
    } catch (e) {
      toast.error(`Failed to uninstall: ${(e as Error).message}`);
    } finally {
      setConfirmUninstall(null);
    }
  };

  const handleToggleEnabled = async (skill: InstalledSkill, value: boolean) => {
    try {
      await getSkillsRegistry().setEnabled(skill.name, value);
    } catch (e) {
      toast.error(`Failed to update: ${(e as Error).message}`);
    }
  };

  const handleTryInChat = async (skill: InstalledSkill) => {
    const homeBase = chrome.runtime.getURL("/home.html");
    const targetUrl = `${homeBase}?prefill=${encodeURIComponent(`/${skill.name} `)}`;

    // Prefer an existing pinned home tab so the user lands on their workspace
    // rather than spawning a duplicate. We search across all windows: the
    // home tab usually lives in a space window, while settings was opened
    // into the focused window which may differ.
    const tabs = await chrome.tabs.query({ url: `${homeBase}*` });
    const target =
      tabs.find((t) => t.pinned && t.id !== undefined) ??
      tabs.find((t) => t.id !== undefined);

    if (target?.id !== undefined) {
      await chrome.tabs.update(target.id, { url: targetUrl, active: true });
      if (target.windowId !== undefined) {
        await chrome.windows.update(target.windowId, { focused: true });
      }
      return;
    }

    // No home tab open anywhere — create one pinned, matching the existing
    // openHomePage flow.
    await chrome.tabs.create({ url: targetUrl, pinned: true, active: true });
  };

  // Path of the file currently being rendered in Mode A's SKILL.md preview
  // card OR Mode B's file viewer (these are mutually exclusive).
  const skillMdPath = activeSkill
    ? `skills/${activeSkill.name}/SKILL.md`
    : null;
  const filePath =
    activeSkill && selectedFilePath
      ? `skills/${activeSkill.name}/${selectedFilePath}`
      : null;

  const skillMdFile = useSkillFile(filePath ? null : skillMdPath);
  const fileFile = useSkillFile(filePath);

  const fileName = selectedFilePath
    ? (selectedFilePath.split("/").pop() ?? selectedFilePath)
    : "";

  const handleCopy = async () => {
    if (fileFile.content?.kind !== "text") return;
    try {
      await navigator.clipboard.writeText(fileFile.content.text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error("Copy failed");
    }
  };

  const handleDownload = () => {
    if (!fileFile.content) return;
    if (fileFile.content.kind === "blob") {
      downloadBlob(fileFile.content.blob, fileName);
    } else {
      downloadText(fileFile.content.text, fileName);
    }
  };

  return (
    <TooltipProvider>
      <div className="flex h-full -m-4">
        {/* Left panel — skills list & file tree */}
        <div className="w-64 shrink-0 border-r border-border flex flex-col">
          {/* Header */}
          <div className="flex items-center justify-between px-3 py-2 border-b border-border">
            <span className="text-sm font-medium">Skills</span>
            <div className="flex items-center gap-0.5">
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    onClick={() => setSearchOpen((v) => !v)}
                    className="p-1 rounded-md hover:bg-accent transition-colors"
                    aria-label="Search skills"
                  >
                    <Search className="h-4 w-4" />
                  </button>
                </TooltipTrigger>
                <TooltipContent>Search skills</TooltipContent>
              </Tooltip>
              <DropdownMenu>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <DropdownMenuTrigger asChild>
                      <button
                        className="p-1 rounded-md hover:bg-accent transition-colors"
                        aria-label="Add skill"
                      >
                        <Plus className="h-4 w-4" />
                      </button>
                    </DropdownMenuTrigger>
                  </TooltipTrigger>
                  <TooltipContent>Add skill</TooltipContent>
                </Tooltip>
                <DropdownMenuContent
                  align="center"
                  side="bottom"
                  className="w-44"
                >
                  <DropdownMenuItem onClick={() => setInstallOpen(true)}>
                    <Download className="h-4 w-4" />
                    Install from URL
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => setUploadOpen(true)}>
                    <Upload className="h-4 w-4" />
                    Upload a skill
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>

          {searchOpen && (
            <div className="px-3 py-2 border-b border-border">
              <input
                type="text"
                autoFocus
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search skills..."
                className="w-full bg-transparent border border-border rounded-md px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
              />
            </div>
          )}

          {/* Lists */}
          <div className="flex-1 overflow-y-auto py-1">
            {skills.length === 0 ? (
              <div className="px-3 py-4 text-xs text-muted-foreground italic">
                No skills installed yet.
              </div>
            ) : (
              <>
                {personalSkills.length > 0 && (
                  <SkillGroup
                    label="Personal skills"
                    skills={personalSkills}
                    selectedSkillName={selectedSkillName}
                    selectedFilePath={selectedFilePath}
                    onSelectSkill={handleSelectSkill}
                    onSelectFile={handleSelectFile}
                  />
                )}
                {builtInSkills.length > 0 && (
                  <SkillGroup
                    label="Built-in skills"
                    skills={builtInSkills}
                    selectedSkillName={selectedSkillName}
                    selectedFilePath={selectedFilePath}
                    onSelectSkill={handleSelectSkill}
                    onSelectFile={handleSelectFile}
                  />
                )}
              </>
            )}
          </div>
        </div>

        {/* Right panel — detail view */}
        <div className="flex-1 min-w-0 overflow-y-auto">
          {!activeSkill ? (
            <div className="h-full flex items-center justify-center text-sm text-muted-foreground">
              {skills.length === 0
                ? "Install or upload a skill to get started."
                : "Select a skill to view its details."}
            </div>
          ) : selectedFilePath ? (
            // ─────────────────────── Mode B: file selected ───────────────────────
            <div className="min-w-0 flex flex-col">
              {/* Sticky header — sticks to the top of the scrolling right pane
                  while the file content scrolls underneath. */}
              <div className="sticky top-0 z-10 bg-background">
                <div className="flex items-center justify-between gap-4 px-6 pt-5 pb-3">
                  <h2 className="text-sm font-medium font-mono truncate">
                    {fileName}
                  </h2>
                  <div className="flex items-center gap-2">
                    {fileName.toLowerCase().endsWith(".md") && (
                      <ModeToggle mode={fileMode} onChange={setFileMode} />
                    )}
                    <button
                      onClick={handleDownload}
                      disabled={!fileFile.content}
                      className="p-1.5 rounded-md hover:bg-accent transition-colors disabled:opacity-50"
                      aria-label="Download file"
                      title="Download"
                    >
                      <Download className="h-3.5 w-3.5" />
                    </button>
                    <button
                      onClick={handleCopy}
                      className="p-1.5 rounded-md hover:bg-accent transition-colors"
                      aria-label="Copy file content"
                      title="Copy"
                    >
                      {copied ? (
                        <Check className="h-3.5 w-3.5" />
                      ) : (
                        <Copy className="h-3.5 w-3.5" />
                      )}
                    </button>
                  </div>
                </div>
                <div className="border-b border-border mx-6" />
              </div>

              {/* Body */}
              <div className="px-6 py-4 flex flex-col gap-4">
                {/* Frontmatter description block — only for SKILL.md */}
                {fileName === "SKILL.md" && (
                  <DescriptionBlock description={activeSkill.description} />
                )}

                <div className="min-w-0 overflow-x-auto">
                  <SkillFileViewer
                    fileName={fileName}
                    content={fileFile.content}
                    mode={fileMode}
                    loading={fileFile.loading}
                    error={fileFile.error}
                    lineNumbers
                  />
                </div>
              </div>
            </div>
          ) : (
            // ─────────────────────── Mode A: skill selected ──────────────────────
            <div className="p-6 flex flex-col gap-5 min-w-0">
              {/* Header */}
              <div className="flex items-start justify-between gap-4">
                <h1 className="text-2xl font-semibold truncate">
                  {activeSkill.name}
                </h1>
                <div className="flex items-center gap-2">
                  <Switch
                    checked={activeSkill.enabled !== false}
                    onCheckedChange={(v) => handleToggleEnabled(activeSkill, v)}
                  />
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <button
                        className="p-2 rounded-md hover:bg-accent transition-colors"
                        aria-label="More actions"
                      >
                        <MoreHorizontal className="h-4 w-4" />
                      </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem
                        onClick={() => handleTryInChat(activeSkill)}
                      >
                        <MessageSquare className="h-4 w-4" />
                        Try in chat
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        className="text-destructive focus:text-destructive"
                        onClick={() => setConfirmUninstall(activeSkill.name)}
                      >
                        <Trash2 className="h-4 w-4" />
                        Uninstall
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </div>

              {/* Metadata grid */}
              <div className="grid grid-cols-[auto_1fr] gap-x-12 gap-y-2 text-sm">
                <div className="text-muted-foreground">Added by</div>
                <div>
                  {addedByForSkill(activeSkill.source, activeSkill.metadata)}
                </div>
                <div className="text-muted-foreground">Trigger</div>
                <div>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span className="underline decoration-dotted underline-offset-4 decoration-muted-foreground/50 cursor-default">
                        Slash command + auto
                      </span>
                    </TooltipTrigger>
                    <TooltipContent>
                      Appears in the / menu. OpenCode can also run it
                      automatically when relevant.
                    </TooltipContent>
                  </Tooltip>
                </div>
              </div>

              <DescriptionBlock description={activeSkill.description} />

              {/* Source link (non-bundled) */}
              {activeSkill.source !== "bundled" &&
                (() => {
                  const parsed = parseSkillSource(activeSkill.source);
                  if (!parsed) {
                    return (
                      <div className="text-xs text-muted-foreground">
                        Source:{" "}
                        <span className="font-mono">{activeSkill.source}</span>
                      </div>
                    );
                  }
                  return (
                    <div className="text-xs text-muted-foreground">
                      Source:{" "}
                      <a
                        href={parsed.repoUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 text-foreground hover:underline"
                      >
                        {parsed.displayName}
                        <ExternalLink className="h-3 w-3" />
                      </a>
                    </div>
                  );
                })()}

              {/* Scripts warning */}
              {activeSkill.hasScripts && (
                <div className="bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/30 rounded-md p-3 text-xs">
                  <strong>Contains scripts:</strong> This skill includes
                  executable scripts ({activeSkill.scriptTypes.join(", ")}).
                  OpenBrowse runs in the browser and cannot execute them — the
                  agent will read them as context only.
                </div>
              )}

              {/* SKILL.md preview card */}
              <div className="border border-border rounded-lg bg-muted/30 overflow-hidden relative">
                <div className="absolute top-3 right-3 z-10">
                  <ModeToggle
                    mode={skillCardMode}
                    onChange={setSkillCardMode}
                  />
                </div>
                <div className="p-6 max-h-[60vh] overflow-y-auto">
                  <SkillFileViewer
                    fileName="SKILL.md"
                    content={skillMdFile.content}
                    mode={skillCardMode}
                    loading={skillMdFile.loading}
                    error={skillMdFile.error}
                    lineNumbers
                  />
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Dialogs */}
        <InstallSkillDialog
          open={installOpen}
          onOpenChange={setInstallOpen}
          githubToken={settings?.githubToken}
        />
        <UploadSkillDialog open={uploadOpen} onOpenChange={setUploadOpen} />

        <AlertDialog
          open={confirmUninstall !== null}
          onOpenChange={(o) => !o && setConfirmUninstall(null)}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Uninstall skill?</AlertDialogTitle>
              <AlertDialogDescription>
                This will remove "{confirmUninstall}" and all of its files from
                OpenBrowse. This cannot be undone.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                onClick={() =>
                  confirmUninstall && handleUninstall(confirmUninstall)
                }
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              >
                Uninstall
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </TooltipProvider>
  );
}

// ─── Sub-components ──────────────────────────────────────────────────────────

interface SkillGroupProps {
  label: string;
  skills: InstalledSkill[];
  selectedSkillName: string | null;
  selectedFilePath: string | null;
  onSelectSkill: (name: string) => void;
  onSelectFile: (path: string) => void;
}

function SkillGroup({
  label,
  skills,
  selectedSkillName,
  selectedFilePath,
  onSelectSkill,
  onSelectFile,
}: SkillGroupProps) {
  const [open, setOpen] = useState(true);
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="px-1 py-1">
      <CollapsibleTrigger asChild>
        <button
          type="button"
          className="w-full flex items-center gap-1 px-2 py-1 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
        >
          <ChevronDown
            className={`h-3 w-3 transition-transform ${
              open ? "" : "-rotate-90"
            }`}
          />
          <span>{label}</span>
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        {skills.map((skill) => (
          <SkillRow
            key={skill.name}
            skill={skill}
            isSelected={selectedSkillName === skill.name}
            selectedFilePath={
              selectedSkillName === skill.name ? selectedFilePath : null
            }
            onSelect={onSelectSkill}
            onSelectFile={onSelectFile}
          />
        ))}
      </CollapsibleContent>
    </Collapsible>
  );
}

interface SkillRowProps {
  skill: InstalledSkill;
  isSelected: boolean;
  selectedFilePath: string | null;
  onSelect: (name: string) => void;
  onSelectFile: (path: string) => void;
}

function SkillRow({
  skill,
  isSelected,
  selectedFilePath,
  onSelect,
  onSelectFile,
}: SkillRowProps) {
  const isDisabled = skill.enabled === false;
  // The skill row is "active" when this skill is selected, but it should only
  // visually highlight (bg-accent) when no file underneath is selected — once
  // a file is picked, the highlight transfers to that file row.
  const showHighlight = isSelected && !selectedFilePath;
  return (
    <div>
      <button
        type="button"
        onClick={() => onSelect(skill.name)}
        className={`w-full flex items-center justify-between gap-2 px-2 py-1 text-sm rounded transition-colors ${
          showHighlight
            ? "bg-accent text-accent-foreground font-medium"
            : isSelected
              ? "font-medium hover:bg-accent/50"
              : "hover:bg-accent/50"
        } ${isDisabled ? "opacity-60" : ""}`}
      >
        <span className="truncate">{skill.name}</span>
        {isSelected && (
          <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" />
        )}
      </button>
      {isSelected && skill.fileIndex.length > 0 && (
        <SkillFileTree
          paths={skill.fileIndex}
          selectedPath={selectedFilePath}
          onSelect={onSelectFile}
          muted={isDisabled}
        />
      )}
    </div>
  );
}

interface ModeToggleProps {
  mode: SkillFileViewMode;
  onChange: (mode: SkillFileViewMode) => void;
}

function ModeToggle({ mode, onChange }: ModeToggleProps) {
  return (
    <div className="flex items-center bg-background/80 border border-border rounded-md p-0.5">
      <button
        type="button"
        onClick={() => onChange("preview")}
        className={`p-1 rounded transition-colors ${
          mode === "preview"
            ? "bg-accent text-accent-foreground"
            : "text-muted-foreground hover:text-foreground"
        }`}
        aria-label="Preview"
      >
        <Eye className="h-3.5 w-3.5" />
      </button>
      <button
        type="button"
        onClick={() => onChange("code")}
        className={`p-1 rounded transition-colors ${
          mode === "code"
            ? "bg-accent text-accent-foreground"
            : "text-muted-foreground hover:text-foreground"
        }`}
        aria-label="Source"
      >
        <CodeIcon className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

interface DescriptionBlockProps {
  description: string;
}

function DescriptionBlock({ description }: DescriptionBlockProps) {
  return (
    <div>
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground mb-1.5">
        <span>Description</span>
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="inline-flex">
              <Info className="h-3 w-3" />
            </span>
          </TooltipTrigger>
          <TooltipContent side="right" className="max-w-xs">
            Description from the skill's YAML frontmatter — agents use this to
            decide when to invoke a skill.
          </TooltipContent>
        </Tooltip>
      </div>
      <p className="text-sm leading-relaxed">{description}</p>
    </div>
  );
}

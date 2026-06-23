import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { useHotkeys } from "react-hotkeys-hook";
import { ChevronRight, Download, Plus, Upload, X } from "lucide-react";
import { storage } from "@/lib/storage";
import { OPFS } from "@/lib/vfs/opfs";
import {
  countLines,
  formatBytes,
  getTypeBadge,
  isTextFile,
} from "@/lib/chat/attachment-meta";
import { validateFiles } from "@/lib/chat/validate-files";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { memoryDb, type Memory } from "@/lib/memory-db";
import { getSkillsRegistry } from "@/lib/skills/registry";
import type { InstalledSkill, SpaceSkillConfig } from "@/lib/skills/types";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { MemoryItem } from "@/components/memory/MemoryItem";
import { InstallSkillDialog } from "@/entrypoints/settings/skills/InstallSkillDialog";
import { UploadSkillDialog } from "@/entrypoints/settings/skills/UploadSkillDialog";
import type { Space } from "@/lib/types";

/**
 * In-context space configuration surface, embedded into the chat
 * `LandingPage`'s right rail when a space is active. A scrollable
 * stack of `Collapsible` sections: Instructions (drafted; ⌘S/Save/
 * Revert), Files, Memory, Skills.
 *
 * The discrete identity controls (icon, name, description, color)
 * live in the page-spanning `SpaceLandingHeader` instead of inside
 * the rail — see `LandingPage.tsx`.
 */
export function SpaceCustomization({
  space,
  onSelectFile,
}: {
  space: Space;
  /**
   * Open a Space file in a viewer when its card is clicked. Threaded
   * through to `SpaceFilesSection` → `SpaceFileCard`. Optional so
   * surfaces that don't host a viewer (e.g. embedded previews) can
   * mount this component without wiring file selection.
   */
  onSelectFile?: (rel: string) => void;
}) {
  const [draftInstructions, setDraftInstructions] = useState(
    space.instructions ?? "",
  );

  // Re-sync the draft whenever the upstream `space` row changes (e.g.
  // after our own save commits, or after a cross-context update from
  // another extension surface). Without this, an external rename or
  // a concurrent edit would leave the textarea showing stale text.
  useEffect(() => {
    setDraftInstructions(space.instructions ?? "");
  }, [space.id, space.instructions]);

  const dirty = draftInstructions !== (space.instructions ?? "");

  const handleSave = useCallback(async () => {
    if (!dirty) return;
    const next = draftInstructions.trim() ? draftInstructions : null;
    await storage.updateSpace(space.id, { instructions: next });
  }, [dirty, draftInstructions, space.id]);

  const handleRevert = useCallback(() => {
    setDraftInstructions(space.instructions ?? "");
  }, [space.instructions]);

  // ⌘S / Ctrl+S still works when the customization region is mounted —
  // matches user expectation from the deleted SpaceDetail page. Saves
  // the draft instructions if dirty; otherwise no-op.
  useHotkeys(
    "mod+s",
    (e) => {
      if (!dirty) return;
      e.preventDefault();
      void handleSave();
    },
    { enableOnFormTags: true },
    [dirty, handleSave],
  );

  return (
    <div className="px-6 py-6 space-y-6" data-testid="space-customization">
      <CustomizationSection id="instructions" title="Instructions" defaultOpen>
        <p className="text-xs text-muted-foreground mb-2">
          Tell OpenBrowse how it should work in this space.
        </p>
        <Textarea
          value={draftInstructions}
          onChange={(e) => setDraftInstructions(e.target.value)}
          rows={6}
          placeholder="e.g. Always cite sources. Prefer markdown tables for comparisons."
          className="min-h-32 font-mono text-sm"
        />
      </CustomizationSection>

      <CustomizationSection id="files" title="Files" defaultOpen>
        <SpaceFilesSection space={space} onSelectFile={onSelectFile} />
      </CustomizationSection>

      <CustomizationSection id="memory" title="Memory">
        <SpaceMemorySection space={space} />
      </CustomizationSection>

      <CustomizationSection id="skills" title="Skills">
        <SpaceSkillsSection space={space} />
      </CustomizationSection>

      {/* Floating dirty bar — `position: fixed` so it lives in viewport
          coordinates and isn't clipped by the rail's `overflow-y-auto`.
          The transition lets it slide up from the bottom edge on first
          dirty, and fade back down on save/revert. `pointer-events-none`
          when idle so it doesn't intercept clicks meant for the
          composer below. */}
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
          <Button
            size="sm"
            onClick={() => void handleSave()}
            disabled={!dirty}
          >
            Save <Kbd className="ml-1.5">⌘S</Kbd>
          </Button>
        </div>
      </div>
    </div>
  );
}

/**
 * One row of the customization stack — a section header that toggles a
 * Radix `Collapsible`. The chevron rotates 90° on open, matching the
 * disclosure pattern shadcn uses elsewhere in this app (see
 * `MemoryItem`).
 */
function CustomizationSection({
  id,
  title,
  defaultOpen = false,
  children,
}: {
  id: string;
  title: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <Collapsible open={open} onOpenChange={setOpen} data-section={id}>
      <CollapsibleTrigger className="flex w-full items-center gap-2 py-1 text-sm font-semibold text-foreground hover:text-foreground/80 transition-colors">
        <ChevronRight
          className={`size-4 shrink-0 transition-transform ${open ? "rotate-90" : ""}`}
        />
        {title}
      </CollapsibleTrigger>
      <CollapsibleContent className="overflow-hidden data-[state=open]:animate-collapsible-down data-[state=closed]:animate-collapsible-up">
        <div className="pt-2">{children}</div>
      </CollapsibleContent>
    </Collapsible>
  );
}

/**
 * General settings — the icon, name, and color of the space, laid out
 * in a single inline row that fits the rail's narrow column. Each
 * control autosaves: emoji selection commits immediately, the name
 * input commits on blur (with empty-revert), and the color picker
 * commits on save.
 */
interface SpaceFile {
  /** Path relative to the space workspace root (e.g. "notes.md"). */
  rel: string;
  /** File size in bytes; null while metadata is still loading. */
  size: number | null;
  /** Line count for text-classifiable files; null otherwise. */
  lineCount: number | null;
}

function SpaceFilesSection({
  space,
  onSelectFile,
}: {
  space: Space;
  /**
   * Open the file in a viewer. When omitted, file cards are display-only
   * (matching surfaces that don't host a viewer, e.g. embedded previews).
   */
  onSelectFile?: (rel: string) => void;
}) {
  const root = `spaces/${space.id}/workspace`;
  const [files, setFiles] = useState<SpaceFile[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Drag-over visual state. `dragCounter` de-flickers nested
  // dragenter/leave events fired from child elements.
  const [isDragOver, setIsDragOver] = useState(false);
  const dragCounter = useRef(0);

  const refresh = useCallback(async () => {
    // Walk first to render skeletons quickly, then fill in metadata in
    // parallel so the user sees something immediately even when several
    // files need to be classified.
    const found: string[] = [];
    try {
      for await (const p of OPFS.walk(root)) {
        if (p.startsWith(`${root}/`)) found.push(p.slice(root.length + 1));
      }
    } catch {
      // Root may not exist yet; that's fine — empty list.
    }
    found.sort();
    setFiles(found.map((rel) => ({ rel, size: null, lineCount: null })));

    // Resolve metadata in parallel; update the row in place once each
    // file's bytes (and optionally line count) are available.
    await Promise.all(
      found.map(async (rel) => {
        try {
          const blob = await OPFS.readFileBytes(`${root}/${rel}`);
          let lineCount: number | null = null;
          if (isTextFile(rel)) {
            try {
              const text = await blob.text();
              lineCount = countLines(text);
            } catch {
              // Decoding failed — fall back to bytes-only.
            }
          }
          setFiles((prev) =>
            prev.map((f) =>
              f.rel === rel ? { ...f, size: blob.size, lineCount } : f,
            ),
          );
        } catch {
          // File vanished or unreadable — leave it in the list with
          // size: null. The trash button still works to clean it up.
        }
      }),
    );
  }, [root]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Shared write path used by both click-upload and drag-drop. Mirrors
  // the chat composer's validation (50 MB cap, 10 files per batch) so
  // the two surfaces give consistent feedback when a user drops the
  // same files into either.
  const addFiles = useCallback(
    async (incoming: FileList | File[]) => {
      const MB = 1024 * 1024;
      const arr = Array.from(incoming);
      if (arr.length === 0) return;
      const { accepted, rejections } = validateFiles(arr, {
        // No per-provider image cap here — space files aren't sent
        // inline to a model — so use the same cap for everything.
        fileCap: 50 * MB,
        imageCap: 50 * MB,
        countCap: 10,
      });
      for (const msg of rejections) {
        toast.error(msg);
      }
      // Serialize writes: `OPFS.uniquePath` + `writeFileBytes` is not
      // atomic, so two concurrent writes to the same dir can race on
      // the same suffix. The original click-upload path was also
      // serial; keep that.
      for (const file of accepted) {
        const dest = await OPFS.uniquePath(root, file.name);
        await OPFS.writeFileBytes(dest, file);
      }
      if (accepted.length > 0) refresh();
    },
    [root, refresh],
  );

  async function handleFileInput(e: React.ChangeEvent<HTMLInputElement>) {
    const input = e.target.files;
    if (!input) return;
    await addFiles(input);
    e.target.value = "";
  }

  async function remove(rel: string) {
    await OPFS.rm(`${root}/${rel}`);
    refresh();
  }

  // Drag-and-drop handlers. We `stopPropagation()` so a page-level
  // drop zone (LandingPage) doesn't also receive the same drop and
  // route the files into the chat composer.
  const handleDragEnter = useCallback((e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes("Files")) return;
    e.preventDefault();
    e.stopPropagation();
    dragCounter.current += 1;
    setIsDragOver(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes("Files")) return;
    e.stopPropagation();
    dragCounter.current -= 1;
    if (dragCounter.current <= 0) {
      dragCounter.current = 0;
      setIsDragOver(false);
    }
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes("Files")) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = "copy";
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      if (!e.dataTransfer.types.includes("Files")) return;
      e.preventDefault();
      e.stopPropagation();
      dragCounter.current = 0;
      setIsDragOver(false);
      const dropped = e.dataTransfer.files;
      if (dropped.length > 0) void addFiles(dropped);
    },
    [addFiles],
  );

  return (
    <div
      // `data-space-files-dropzone` is read by the LandingPage's
      // page-level drop handler as a defensive hit-test, in addition
      // to our `stopPropagation()` on the events below.
      data-space-files-dropzone=""
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
      className={cn(
        "relative rounded-md transition-colors",
        isDragOver && "ring-2 ring-blue-500/60 bg-blue-500/5",
      )}
    >
      <p className="text-xs text-muted-foreground mb-3">
        Add reference docs, data, or files that OpenBrowse should use as
        context. You can ask OpenBrowse to upload or edit files in this
        space.
      </p>
      <div className="flex flex-wrap gap-2">
        {files.map((f) => (
          <SpaceFileCard
            key={f.rel}
            file={f}
            onRemove={() => remove(f.rel)}
            onSelect={onSelectFile}
          />
        ))}
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          className="flex h-[108px] w-[140px] flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-border text-muted-foreground hover:text-foreground hover:border-foreground/30 transition-colors"
          aria-label="Upload files"
        >
          <Plus className="size-5" />
          <span className="text-xs">Upload</span>
        </button>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          onChange={handleFileInput}
        />
      </div>
      {/* Drop overlay — non-interactive, only visual. Sits above the
          card grid so the dashed ring frames the whole section. */}
      {isDragOver && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center rounded-md">
          <div className="flex items-center gap-2 rounded-md bg-background/90 px-3 py-1.5 shadow-sm border border-blue-500/40">
            <Upload className="size-4 text-blue-500" />
            <span className="text-xs font-medium">Drop files to add to space</span>
          </div>
        </div>
      )}
    </div>
  );
}

function SpaceFileCard({
  file,
  onRemove,
  onSelect,
}: {
  file: SpaceFile;
  onRemove: () => void;
  /**
   * Open the file in a viewer when the card body is clicked. When omitted,
   * the card body is non-interactive (the X remove button still works).
   * The argument is the workspace-relative path (`file.rel`).
   */
  onSelect?: (rel: string) => void;
}) {
  // Display name: just the basename so long nested paths still read at
  // a glance. The full path is in the title for power users.
  const basename = file.rel.split("/").pop() ?? file.rel;
  const meta =
    file.lineCount != null
      ? `${file.lineCount} ${file.lineCount === 1 ? "line" : "lines"}`
      : file.size != null
        ? formatBytes(file.size)
        : "";

  // Card body — same visual contents either way. Wrapped in a
  // `<button>` when `onSelect` is provided so the whole card is a
  // single click target with native focus/keyboard behavior; rendered
  // as a plain `<div>` otherwise so consumers without a viewer wired up
  // don't accidentally render a clickable-looking control.
  const body = (
    <div className="flex h-[108px] w-[140px] flex-col gap-1 rounded-lg border border-border bg-background p-2.5 text-left">
      <div className="line-clamp-3 break-words text-xs font-medium leading-tight text-foreground">
        {basename}
      </div>
      <div className="text-[11px] text-muted-foreground">
        {meta || (
          <span className="inline-block h-3 w-12 rounded bg-muted animate-pulse" />
        )}
      </div>
      <div className="mt-auto">
        <span className="inline-block rounded-full border border-border px-1.5 py-0.5 text-[10px] font-medium leading-none text-muted-foreground">
          {getTypeBadge(basename)}
        </span>
      </div>
    </div>
  );

  return (
    <div
      className="relative group animate-in fade-in-0 zoom-in-95 duration-200"
      title={file.rel}
    >
      {onSelect ? (
        <button
          type="button"
          onClick={() => onSelect(file.rel)}
          className="block rounded-lg transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label={`Open ${basename}`}
        >
          {body}
        </button>
      ) : (
        body
      )}
      <button
        type="button"
        onClick={(e) => {
          // Don't bubble into the card body's open-on-click handler.
          e.stopPropagation();
          onRemove();
        }}
        aria-label={`Remove ${basename}`}
        className="absolute -right-1 -top-1 size-4 flex items-center justify-center rounded-full bg-background border border-border shadow-sm opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity"
      >
        <X className="size-2.5" />
      </button>
    </div>
  );
}

function SpaceMemorySection({ space }: { space: Space }) {
  const [memories, setMemories] = useState<Memory[]>([]);

  const refresh = useCallback(async () => {
    const all = await memoryDb.list(space.id);
    // memoryDb.list returns global memories AND space-scoped memories.
    // Filter to only this space.
    setMemories(all.filter((m) => m.spaceId === space.id));
  }, [space.id]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  async function remove(id: string) {
    await memoryDb.delete(id);
    refresh();
  }

  return (
    <>
      <p className="text-xs text-muted-foreground mb-3">
        Things OpenBrowse remembers from this space across conversations.
      </p>
      {memories.length === 0 ? (
        <p className="text-sm text-muted-foreground">No memories saved yet</p>
      ) : (
        <div className="flex flex-col gap-2">
          {memories.map((m) => (
            <MemoryItem key={m.id} memory={m} onDelete={remove} />
          ))}
        </div>
      )}
    </>
  );
}

function SpaceSkillsSection({ space }: { space: Space }) {
  const [skills, setSkills] = useState<InstalledSkill[]>([]);
  const [configs, setConfigs] = useState<SpaceSkillConfig[]>([]);
  const [installOpen, setInstallOpen] = useState(false);
  const [uploadOpen, setUploadOpen] = useState(false);

  const refresh = useCallback(() => {
    const reg = getSkillsRegistry();
    const state = reg.getState();
    setSkills(state.skills);
    setConfigs(state.spaceConfigs.filter((c) => c.spaceId === space.id));
  }, [space.id]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const reg = getSkillsRegistry();
      await reg.init();
      if (cancelled) return;
      refresh();
    })();
    const reg = getSkillsRegistry();
    const unsub = reg.subscribe(refresh);
    return () => {
      cancelled = true;
      unsub();
    };
  }, [refresh]);

  // Built-in (bundled) skills are always enabled for every space — they're
  // OpenBrowse's first-party capabilities and not user-configurable here.
  // This view shows only personal (non-bundled) skills the user has installed
  // globally; the toggle controls whether each is allowed in *this* space.
  const personalSkills = skills.filter((s) => s.source !== "bundled");

  function isEnabledForSpace(name: string): boolean {
    const skill = personalSkills.find((s) => s.name === name);
    if (skill?.enabled === false) return false;
    const cfg = configs.find((c) => c.skillName === name);
    return cfg?.state !== "deny";
  }

  async function toggle(name: string, enabled: boolean) {
    await getSkillsRegistry().setSpaceState(
      space.id,
      name,
      enabled ? "allow" : "deny",
    );
    // The registry broadcasts SKILL_STATE_CHANGED; subscribe handler will refresh.
  }

  return (
    <>
      <div className="flex items-center justify-between mb-2">
        <p className="text-xs text-muted-foreground">
          Extend what OpenBrowse can do in this space with reusable
          capabilities and actions. OpenBrowse applies skills automatically
          when needed.
        </p>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 shrink-0 ml-2"
              aria-label="Add skill"
            >
              <Plus className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-44">
            <DropdownMenuItem onClick={() => setInstallOpen(true)}>
              <Download className="size-4" />
              Install from URL
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => setUploadOpen(true)}>
              <Upload className="size-4" />
              Upload a skill
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {personalSkills.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No personal skills installed yet. Add one from the URL or by uploading a file.
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {personalSkills.map((s) => {
            const globallyDisabled = s.enabled === false;
            const enabledForSpace = isEnabledForSpace(s.name);
            return (
              <li
                key={s.name}
                className="flex items-center gap-3 text-sm border border-border rounded-md p-3"
              >
                <div className="flex-1 min-w-0">
                  <div className="font-medium truncate">{s.name}</div>
                  {s.description && (
                    <div className="text-xs text-muted-foreground truncate">
                      {s.description}
                    </div>
                  )}
                  {globallyDisabled && (
                    <div className="text-[11px] text-muted-foreground italic mt-0.5">
                      Globally disabled
                    </div>
                  )}
                </div>
                <Switch
                  checked={enabledForSpace && !globallyDisabled}
                  disabled={globallyDisabled}
                  onCheckedChange={(v) => toggle(s.name, v)}
                  aria-label={`${enabledForSpace ? "Disable" : "Enable"} ${s.name} for this space`}
                />
              </li>
            );
          })}
        </ul>
      )}

      <InstallSkillDialog open={installOpen} onOpenChange={setInstallOpen} />
      <UploadSkillDialog open={uploadOpen} onOpenChange={setUploadOpen} />
    </>
  );
}

import { SkillSlash } from "@/components/tiptap/skill-slash-extension";
import { TabMention } from "@/components/tiptap/tab-mention-extension";
import {
  Combobox,
  ComboboxContent,
  ComboboxGroup,
  ComboboxInput,
  ComboboxItem,
  ComboboxLabel,
  ComboboxList,
} from "@/components/ui/combobox";
import { Kbd } from "@/components/ui/kbd";
import { RegistryIcon } from "@/components/ui/registry-icon";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { ZoomableImage } from "@/components/ui/zoomable-image";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { getImageSizeLimit } from "@/lib/agent/vision-limits";
import {
  countLines,
  formatBytes,
  getTypeBadge,
  isTextFile,
} from "@/lib/chat/attachment-meta";
import { cn } from "@/lib/utils";
import type { Attachment } from "@/lib/chat/types";
import type { ThinkingConfig } from "@/lib/types";
import type { JSONContent } from "@tiptap/core";
import HardBreak from "@tiptap/extension-hard-break";
import Placeholder from "@tiptap/extension-placeholder";
import { Markdown } from "@tiptap/markdown";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import {
  ArrowUp,
  BrainIcon,
  ChevronDown,
  Paperclip,
  Plus,
  Square,
  Star,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useHotkeys } from "react-hotkeys-hook";
import { toast } from "sonner";
import { computeButtonMode } from "./chat-input-mode";

// Derived alias kept for back-compat with call sites that destructure
// images: ImagePreview[] from onSubmit. Tasks 5-6 migrate those sites;
// once they're gone we can delete the alias and the re-export.
type ImagePreview = Extract<Attachment, { kind: "image" }>;

interface ModelOption {
  id: string;
  name: string;
  description?: string;
  intelligence?: "high" | "medium" | "low";
  speed?: "fast" | "medium" | "slow";
  contextWindow?: number;
  maxOutputTokens?: number;
  pricing?: { inputPer1M: number; outputPer1M: number };
  capabilities?: string[];
  recommended?: boolean;
}

interface ProviderModels {
  provider: string;
  label: string;
  models: ModelOption[];
  enabled: boolean;
}

interface ChatInputProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (mentions: TabMentionAttrs[], attachments: Attachment[]) => void;
  /**
   * Optional handler for "queue this message instead of sending now".
   * When provided AND `isLoading` is true AND the input has content, the
   * Send button morphs into a Queue (＋) button and Enter routes here
   * instead of triggering Stop. The hook persists the message in
   * queue-db; the auto-flush watcher dispatches it once the current
   * turn ends.
   */
  onQueue?: (mentions: TabMentionAttrs[], attachments: Attachment[]) => void;
  onStop?: () => void;
  /**
   * When true, the input is being used to edit an existing message
   * (either a sent message or a queued one). The primary button is
   * forced to "Save" mode regardless of `isLoading`, and Enter commits
   * via `onSubmit` instead of branching into queue/stop.
   *
   * The Cmd+Shift+Backspace stop hotkey is preserved (it reads
   * `isLoading` directly), so a user mid-edit can still abort the
   * agent's in-flight turn from the keyboard if they really want to.
   */
  editMode?: boolean;
  isLoading: boolean;
  disabled: boolean;
  providerModels?: ProviderModels[];
  favoriteModels?: string[];
  onFavoriteToggle?: (modelKey: string) => void;
  selectedModel?: string;
  onModelChange?: (modelId: string) => void;
  autoFocus?: boolean;
  focusTrigger?: string | null;
  thinkingEnabled?: boolean;
  thinkingConfig?: ThinkingConfig;
  onThinkingChange?: (enabled: boolean, config?: ThinkingConfig) => void;
  selectedModelCapabilities?: string[];
}

export interface TabMentionAttrs {
  title: string;
  url: string;
  favicon: string;
}

export type { ImagePreview, Attachment };

export function extractTabMentions(json: JSONContent): TabMentionAttrs[] {
  const mentions: TabMentionAttrs[] = [];

  function traverse(node: JSONContent) {
    if (node.type === "tabMention" && node.attrs) {
      mentions.push({
        title: node.attrs.title ?? node.attrs.label ?? "",
        url: node.attrs.url ?? node.attrs.id ?? "",
        favicon: node.attrs.favicon ?? "",
      });
    }
    if (node.content) {
      for (const child of node.content) {
        traverse(child);
      }
    }
  }

  traverse(json);
  return mentions;
}

export async function fetchTabContent(url: string): Promise<{
  title: string;
  h1: string;
  description: string;
  bodyText: string;
} | null> {
  try {
    const tabs = await chrome.tabs.query({ url });
    const tab = tabs[0];
    if (!tab?.id) return null;

    const response = await chrome.tabs.sendMessage(tab.id, {
      type: "CHAT_EXTRACT_CONTENT",
    });
    return response ?? null;
  } catch {
    return null;
  }
}

export async function formatMentionContext(
  mentions: TabMentionAttrs[],
): Promise<string> {
  if (mentions.length === 0) return "";

  const blocks: string[] = [];
  for (const mention of mentions) {
    const content = await fetchTabContent(mention.url);
    const lines = [
      `[Tab: ${mention.title}](${mention.url})`,
      `URL: ${mention.url}`,
    ];
    if (content?.description) lines.push(`Description: ${content.description}`);
    if (content?.bodyText) {
      lines.push(`Page content:\n${content.bodyText.slice(0, 5000)}`);
    }
    blocks.push(lines.join("\n"));
  }

  return `\n\n-----\n\n<Mentioned tabs>\n${blocks.join("\n\n---\n\n")}\n</Mentioned tabs>`;
}

function formatTokenCount(n: number): string {
  if (n >= 1_000_000)
    return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n % 1_000 === 0 ? 0 : 1)}K`;
  return n.toString();
}

function ModelInfoContent({ model }: { model: ModelOption }) {
  return (
    <div className="flex flex-col gap-2.5 text-xs w-[200px]">
      <div>
        <p className="font-medium text-sm">{model.name}</p>
        {model.description && (
          <p className="opacity-80 mt-1 leading-relaxed">{model.description}</p>
        )}
      </div>

      <div className="flex flex-col gap-1.5 opacity-80">
        {model.contextWindow && (
          <div className="flex justify-between">
            <span>Context</span>
            <span className="opacity-100">
              {formatTokenCount(model.contextWindow)} tokens
            </span>
          </div>
        )}
        {model.maxOutputTokens && (
          <div className="flex justify-between">
            <span>Max output</span>
            <span className="opacity-100">
              {formatTokenCount(model.maxOutputTokens)} tokens
            </span>
          </div>
        )}
        {model.pricing && (
          <>
            <div className="flex justify-between">
              <span>Input pricing</span>
              <span className="opacity-100">
                ${model.pricing.inputPer1M} / 1M
              </span>
            </div>
            <div className="flex justify-between">
              <span>Output pricing</span>
              <span className="opacity-100">
                ${model.pricing.outputPer1M} / 1M
              </span>
            </div>
          </>
        )}
        {model.intelligence && (
          <div className="flex justify-between">
            <span>Intelligence</span>
            <span className="opacity-100 capitalize">{model.intelligence}</span>
          </div>
        )}
        {model.speed && (
          <div className="flex justify-between">
            <span>Speed</span>
            <span className="opacity-100 capitalize">{model.speed}</span>
          </div>
        )}
        {model.capabilities && model.capabilities.length > 0 && (
          <div className="flex flex-wrap gap-1 mt-1">
            {model.capabilities.map((cap) => (
              <span
                key={cap}
                className="rounded bg-foreground/10 px-1.5 py-0.5 text-[10px] capitalize"
              >
                {cap}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

export function ChatInput({
  value,
  onChange,
  onSubmit,
  onQueue,
  onStop,
  editMode = false,
  isLoading,
  disabled,
  providerModels,
  favoriteModels = [],
  onFavoriteToggle,
  selectedModel,
  onModelChange,
  autoFocus,
  focusTrigger,
  thinkingEnabled,
  thinkingConfig,
  onThinkingChange,
  selectedModelCapabilities,
}: ChatInputProps) {
  const onSubmitRef = useRef(onSubmit);
  onSubmitRef.current = onSubmit;
  const onQueueRef = useRef(onQueue);
  onQueueRef.current = onQueue;
  const onStopRef = useRef(onStop);
  onStopRef.current = onStop;
  const isLoadingRef = useRef(isLoading);
  isLoadingRef.current = isLoading;
  const editModeRef = useRef(editMode);
  editModeRef.current = editMode;
  const editorRef = useRef<ReturnType<typeof useEditor>>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const attachmentsRef = useRef(attachments);
  attachmentsRef.current = attachments;
  // Drag-over visual state. `dragCounter` de-flickers nested
  // dragenter/leave events fired from child elements.
  const [isDragOver, setIsDragOver] = useState(false);
  const dragCounter = useRef(0);
  // Back-compat for spots in this file that count or filter to images.
  const images = useMemo(
    () => attachments.filter((a): a is Extract<Attachment, { kind: "image" }> => a.kind === "image"),
    [attachments],
  );
  const lastExternalValue = useRef(value);
  const [modelSelectorOpen, setModelSelectorOpen] = useState(false);
  const [highlightedModelId, setHighlightedModelId] = useState<string | null>(
    null,
  );
  const [modelSearchQuery, setModelSearchQuery] = useState("");
  const modelButtonRef = useRef<HTMLButtonElement>(null);

  const allModelItems = useMemo(() => {
    if (!providerModels) return [];
    return providerModels.flatMap((g) =>
      g.models.map((m) => `${g.provider}:${m.id}`),
    );
  }, [providerModels]);

  const modelIdToName = useMemo(() => {
    const map = new Map<string, string>();
    if (!providerModels) return map;
    for (const group of providerModels) {
      for (const m of group.models) {
        map.set(`${group.provider}:${m.id}`, m.name);
      }
    }
    return map;
  }, [providerModels]);

  const modelIdToProvider = useMemo(() => {
    const map = new Map<string, { provider: string; enabled: boolean }>();
    if (!providerModels) return map;
    for (const group of providerModels) {
      for (const m of group.models) {
        map.set(`${group.provider}:${m.id}`, {
          provider: group.provider,
          enabled: group.enabled,
        });
      }
    }
    return map;
  }, [providerModels]);

  const pickerSections = useMemo(() => {
    if (!providerModels)
      return { favorites: [], recommended: [], providers: [] };
    const q = modelSearchQuery.toLowerCase().trim();

    // Helper to filter models
    const filterModels = (
      models: (typeof providerModels)[0]["models"],
      groupLabel: string,
    ) => {
      if (!q) return models;
      return models.filter(
        (m) =>
          m.name.toLowerCase().includes(q) ||
          groupLabel.toLowerCase().includes(q),
      );
    };

    // 1. Favorites
    const favoriteItems: Array<
      (typeof providerModels)[0]["models"][0] & {
        providerId: string;
        providerLabel: string;
        enabled: boolean;
      }
    > = [];
    // 2. Recommended
    const recommendedItems: typeof favoriteItems = [];

    // We will collect all models into these arrays
    for (const group of providerModels) {
      const models = filterModels(group.models, group.label);
      for (const m of models) {
        const item = {
          ...m,
          providerId: group.provider,
          providerLabel: group.label,
          enabled: group.enabled,
        };
        if (favoriteModels.includes(`${group.provider}:${m.id}`)) {
          favoriteItems.push(item);
        } else if (m.recommended) {
          recommendedItems.push(item);
        }
      }
    }

    // 3. Provider Groups
    const providerGroups = providerModels
      .map((group) => ({
        ...group,
        models: filterModels(group.models, group.label),
      }))
      .filter((group) => group.models.length > 0);

    return {
      favorites: favoriteItems,
      recommended: recommendedItems,
      providers: providerGroups,
    };
  }, [providerModels, modelSearchQuery, favoriteModels]);

  const addFiles = useCallback(
    async (files: FileList | File[]) => {
      const MB = 1024 * 1024;
      const FILE_CAP = 50 * MB;
      const COUNT_CAP = 10;
      const imageCap = selectedModel ? getImageSizeLimit(selectedModel) : 10 * MB;

      const incoming = Array.from(files);
      const rejections: string[] = [];

      const remainingSlots = COUNT_CAP - attachmentsRef.current.length;
      if (incoming.length > remainingSlots) {
        rejections.push(
          `Only ${remainingSlots} more attachment${remainingSlots === 1 ? "" : "s"} allowed (max ${COUNT_CAP} per message).`,
        );
      }

      // Validate synchronously so we can insert placeholder cards
      // immediately. The async metadata work (FileReader for images,
      // file.text() for text-file line counts) runs in parallel and
      // patches each card in place when it lands. Without this, the
      // user sees a delay between picking a file and seeing it appear.
      const slice = incoming.slice(0, Math.max(0, remainingSlots));
      const accepted = slice.flatMap((file) => {
        const isImage = file.type.startsWith("image/");
        const cap = isImage ? imageCap : FILE_CAP;
        if (file.size > cap) {
          const capMB = Math.round(cap / MB);
          rejections.push(
            `${file.name} exceeds the ${capMB} MB ${isImage ? "image" : "file"} limit.`,
          );
          return [];
        }
        return [{ file, isImage, id: crypto.randomUUID() }];
      });

      if (accepted.length > 0) {
        const placeholders: Attachment[] = accepted.map(({ file, isImage, id }) =>
          isImage
            ? {
                kind: "image" as const,
                id,
                file,
                dataUrl: "",
                loading: true,
              }
            : { kind: "file" as const, id, file, loading: true },
        );
        setAttachments((prev) => [...prev, ...placeholders]);
      }

      for (const msg of rejections) {
        toast.error(msg);
      }

      // Resolve async metadata in parallel; patch each placeholder in
      // place by id. If the user removed an attachment before its
      // metadata resolved, the .map below no-ops on the missing id.
      await Promise.all(
        accepted.map(async ({ file, isImage, id }) => {
          if (isImage) {
            const dataUrl = await fileToDataUrl(file);
            setAttachments((prev) =>
              prev.map((a) =>
                a.id === id && a.kind === "image"
                  ? { ...a, dataUrl, loading: false }
                  : a,
              ),
            );
            return;
          }
          let lineCount: number | undefined;
          if (isTextFile(file.name)) {
            try {
              const text = await file.text();
              lineCount = countLines(text);
            } catch {
              // Unreadable as text — leave undefined; card falls back to size.
            }
          }
          setAttachments((prev) =>
            prev.map((a) =>
              a.id === id && a.kind === "file"
                ? { ...a, lineCount, loading: false }
                : a,
            ),
          );
        }),
      );
    },
    [selectedModel],
  );

  const removeAttachment = useCallback((id: string) => {
    setAttachments((prev) => prev.filter((a) => a.id !== id));
  }, []);

  // Container-level drag-and-drop handlers. Activated only for actual
  // file drags (filtered via dataTransfer.types) so text/tab-mention
  // drags pass through unaffected. The counter pattern avoids flicker
  // on dragenter/leave fired from child elements.
  const handleContainerDragEnter = useCallback((e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes("Files")) return;
    e.preventDefault();
    dragCounter.current += 1;
    setIsDragOver(true);
  }, []);

  const handleContainerDragLeave = useCallback((e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes("Files")) return;
    dragCounter.current -= 1;
    if (dragCounter.current <= 0) {
      dragCounter.current = 0;
      setIsDragOver(false);
    }
  }, []);

  const handleContainerDragOver = useCallback((e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes("Files")) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  }, []);

  const handleContainerDrop = useCallback(
    (e: React.DragEvent) => {
      if (!e.dataTransfer.types.includes("Files")) return;
      e.preventDefault();
      dragCounter.current = 0;
      setIsDragOver(false);
      const files = e.dataTransfer.files;
      if (files.length > 0) addFiles(files);
    },
    [addFiles],
  );

  const submitWithMentions = useCallback(() => {
    const ed = editorRef.current;
    if (!ed) return;
    const json = ed.getJSON();
    const mentions = extractTabMentions(json);
    onSubmitRef.current(mentions, attachmentsRef.current);
    setAttachments([]);
  }, []);

  const queueWithMentions = useCallback(() => {
    const handler = onQueueRef.current;
    if (!handler) return;
    const ed = editorRef.current;
    if (!ed) return;
    const json = ed.getJSON();
    const mentions = extractTabMentions(json);
    handler(mentions, attachmentsRef.current);
    setAttachments([]);
  }, []);

  const editor = useEditor({
    autofocus: autoFocus ? "end" : false,
    extensions: [
      // `dropcursor: false` disables ProseMirror's blue vertical
      // insertion-point line on drag-over. We handle file drops at
      // the container level (turning them into attachments) so the
      // editor's own drop cue is misleading.
      StarterKit.configure({ hardBreak: false, dropcursor: false }),
      Placeholder.configure({
        placeholder: "Ask anything... Type @ to mention a tab, / for skills",
        showOnlyWhenEditable: false,
      }),
      Markdown,
      HardBreak.extend({
        addKeyboardShortcuts() {
          return {
            "Mod-Shift-Backspace": () => {
              if (isLoadingRef.current && onStopRef.current) {
                onStopRef.current();
              }
              return true;
            },
            "Shift-Enter": () => this.editor.commands.setHardBreak(),
            Enter: () => {
              const text = this.editor.getMarkdown().trim();
              const hasLoadingAttachment = attachmentsRef.current.some(
                (a) => a.loading,
              );
              const hasContent =
                (text || attachmentsRef.current.length > 0) &&
                !hasLoadingAttachment;

              // Edit mode: Enter commits the edit via onSubmit, regardless
              // of whether the agent is streaming. Save shouldn't morph
              // into Stop or Queue just because there's an in-flight turn.
              if (editModeRef.current) {
                if (hasContent) {
                  submitWithMentions();
                }
                return true;
              }

              // Queue while streaming when there's content AND a queue
              // handler is wired up. Falls back to Stop when the input
              // is empty (preserves the prior "Enter on empty = stop"
              // gesture) or when no queue handler is provided.
              if (isLoadingRef.current) {
                if (hasContent && onQueueRef.current) {
                  queueWithMentions();
                } else if (onStopRef.current) {
                  onStopRef.current();
                }
                return true;
              }

              if (hasContent) {
                submitWithMentions();
              }
              return true;
            },
          };
        },
      }),
      TabMention,
      SkillSlash,
    ],
    editable: true,
    editorProps: {
      attributes: {
        class:
          "resize-none bg-transparent px-2 py-2 text-sm outline-none placeholder:text-muted-foreground prose prose-sm dark:prose-invert max-w-none [&>p]:!my-0 min-h-[60px] max-h-[200px] overflow-y-auto",
      },
      handlePaste: (_view, event) => {
        const files = event.clipboardData?.files;
        if (files && files.length > 0) {
          event.preventDefault();
          addFiles(files);
          return true;
        }
        return false;
      },
      handleDrop: (_view, event) => {
        // File drops are handled by the container-level onDrop on the
        // outer ChatInput div (so dropping anywhere — attachment row,
        // bottom bar, padding — works). We just suppress tiptap's
        // default file-insertion behavior here.
        if (event.dataTransfer?.files && event.dataTransfer.files.length > 0) {
          event.preventDefault();
          return true;
        }
        return false;
      },
    },
    onUpdate: ({ editor: ed }) => {
      const md = ed.getMarkdown();
      lastExternalValue.current = md;
      onChange(md);
    },
  });

  editorRef.current = editor;

  // True while any attachment's async metadata is still resolving.
  // Send is gated on this — submitting with a `loading` image would
  // produce a vision part with an empty data URL and fail at the API.
  const attachmentsLoading = useMemo(
    () => attachments.some((a) => a.loading),
    [attachments],
  );

  const hasContent =
    (value.trim().length > 0 || attachments.length > 0) && !attachmentsLoading;

  /**
   * Tri-state primary button:
   *  - Edit mode (any kind)                     → save  (ArrowUp icon, "Save" tooltip)
   *  - Streaming + has content + onQueue wired  → queue (Plus icon)
   *  - Streaming                                → stop  (Square icon)
   *  - Ready + has content + not disabled       → send  (ArrowUp icon)
   *
   * Edit mode wins outright over streaming so a Save button can't
   * silently morph into Stop while the user is typing changes — even
   * if the agent's stream ended-and-re-started during the edit (e.g.,
   * because the queue auto-flushed an unrelated item).
   *
   * Logic is extracted into `computeButtonMode` for unit testing.
   */
  const buttonMode = computeButtonMode({
    editMode,
    isLoading,
    hasContent,
    hasOnQueue: !!onQueue,
  });

  const handleButtonClick = useCallback(() => {
    if (editMode) {
      if (hasContent && !disabled) submitWithMentions();
      return;
    }
    if (isLoading) {
      if (hasContent && onQueueRef.current) {
        queueWithMentions();
        return;
      }
      onStopRef.current?.();
      return;
    }
    if (hasContent && !disabled) {
      submitWithMentions();
    }
  }, [
    editMode,
    isLoading,
    hasContent,
    disabled,
    submitWithMentions,
    queueWithMentions,
  ]);

  useHotkeys(
    "mod+shift+backspace",
    () => {
      if (isLoadingRef.current && onStopRef.current) {
        onStopRef.current();
      }
    },
    { enableOnFormTags: true },
  );

  useHotkeys(
    "mod+u",
    (e) => {
      // Cmd/Ctrl+U normally opens "View Source" in browsers — suppress
      // and trigger our file picker instead.
      e.preventDefault();
      if (disabled) return;
      fileInputRef.current?.click();
    },
    {
      enableOnFormTags: true,
      // Tiptap uses [contenteditable], which `enableOnFormTags`
      // doesn't cover by itself. This flag makes the hotkey fire
      // while focus is in the chat editor too.
      enableOnContentEditable: true,
      preventDefault: true,
    },
    [disabled],
  );

  useEffect(() => {
    function handleHotkeys(e: KeyboardEvent) {
      if (e.altKey && (e.key === "/" || e.code === "Slash")) {
        e.preventDefault();
        setModelSelectorOpen((prev) => !prev);
      }
      if (modelSelectorOpen && e.altKey && e.shiftKey && (e.key === "c" || e.code === "KeyC" || e.key === "Ç")) {
        e.preventDefault();
        setModelSelectorOpen(false);
        chrome.tabs.create({ url: chrome.runtime.getURL("/settings.html?tab=models") });
      }
    }
    document.addEventListener("keydown", handleHotkeys, true);
    return () => document.removeEventListener("keydown", handleHotkeys, true);
  }, [modelSelectorOpen]);

  useEffect(() => {
    if (!editor) return;
    if (value === lastExternalValue.current) return;
    lastExternalValue.current = value;
    editor.commands.setContent(value, { contentType: "markdown" });
    if (autoFocus) {
      editor.commands.focus("end");
    }
  }, [editor, value, autoFocus]);

  useEffect(() => {
    if (!autoFocus || !editor) return;
    editor.commands.focus("end");
  }, [autoFocus, editor, focusTrigger]);

  useEffect(() => {
    if (!editor) return;
    editor.setEditable(!disabled);
    editor.extensionManager.extensions.forEach((ext) => {
      if (ext.name === "placeholder") {
        (ext.options as { placeholder: string }).placeholder = disabled
          ? "Configure an AI model in settings..."
          : "Ask anything... Type @ to mention a tab";
      }
    });
    editor.view.dispatch(editor.state.tr);
    if (!disabled && autoFocus) {
      editor.commands.focus("end");
    }
  }, [editor, disabled, autoFocus]);

  const selectedModelName = useMemo(() => {
    if (!providerModels || !selectedModel) return selectedModel;
    const [providerId, ...modelIdParts] = selectedModel.split(":");
    const actualModelId =
      modelIdParts.length > 0 ? modelIdParts.join(":") : selectedModel;
    for (const group of providerModels) {
      if (modelIdParts.length > 0 && group.provider !== providerId) continue;
      const found = group.models.find((m) => m.id === actualModelId);
      if (found) return found.name;
    }
    return actualModelId;
  }, [providerModels, selectedModel]);

  return (
    <div
      onDragEnter={handleContainerDragEnter}
      onDragLeave={handleContainerDragLeave}
      onDragOver={handleContainerDragOver}
      onDrop={handleContainerDrop}
      className={cn(
        "relative flex flex-col rounded-lg border bg-card transition-all duration-150",
        isDragOver
          ? "border-blue-500/60 ring-2 ring-blue-500/60 bg-blue-500/5"
          : "border-border",
      )}
    >
      {/* Attachments — animates from 0 to natural height via the
          grid-rows trick so the input box grows smoothly when files
          are added (and shrinks when the last one is removed). */}
      <div
        aria-hidden={attachments.length === 0}
        className={cn(
          "grid transition-[grid-template-rows,opacity] duration-200 ease-out",
          attachments.length > 0
            ? "grid-rows-[1fr] opacity-100"
            : "grid-rows-[0fr] opacity-0",
        )}
      >
        <div className="overflow-hidden">
          <div className="flex flex-wrap gap-1.5 px-2 pt-2">
            {attachments.map((att) => {
              const overImageCap =
                att.kind === "image" &&
                selectedModel != null &&
                att.file.size > getImageSizeLimit(selectedModel);
              return (
                <div
                  key={att.id}
                  className="relative group animate-in fade-in-0 zoom-in-95 duration-200"
                >
                  {att.kind === "image" ? (
                    att.loading ? (
                      <div className="h-[108px] w-[140px] rounded-lg border border-border bg-muted/40 animate-pulse" />
                    ) : (
                      <ZoomableImage
                        src={att.dataUrl}
                        alt={att.file.name}
                        className="h-[108px] w-[140px] object-cover rounded-lg border border-border"
                      />
                    )
                  ) : (
                    <div className="flex h-[108px] w-[140px] flex-col gap-1 rounded-lg border border-border bg-background p-2.5">
                      <div className="line-clamp-3 break-words text-xs font-medium leading-tight text-foreground">
                        {att.file.name}
                      </div>
                      <div className="text-[11px] text-muted-foreground">
                        {att.loading ? (
                          <span className="inline-block h-3 w-12 rounded bg-muted animate-pulse" />
                        ) : att.lineCount !== undefined ? (
                          `${att.lineCount} ${att.lineCount === 1 ? "line" : "lines"}`
                        ) : (
                          formatBytes(att.file.size)
                        )}
                      </div>
                      <div className="mt-auto">
                        <span className="inline-block rounded-full border border-border px-1.5 py-0.5 text-[10px] font-medium leading-none text-muted-foreground">
                          {getTypeBadge(att.file.name)}
                        </span>
                      </div>
                    </div>
                  )}
                  {overImageCap && (
                    <span className="absolute -bottom-1 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-full border border-border bg-background px-1.5 py-0.5 text-[9px] leading-none text-muted-foreground shadow-sm">
                      file only
                    </span>
                  )}
                  <button
                    type="button"
                    onClick={() => removeAttachment(att.id)}
                    className="absolute -right-1 -top-1 size-4 flex items-center justify-center rounded-full bg-background border border-border shadow-sm opacity-0 group-hover:opacity-100 transition-opacity"
                  >
                    <X className="size-2.5" />
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* Editor */}
      <EditorContent editor={editor} className="min-w-0" />

      {/* Bottom bar: model selector left, actions right */}
      <div className="flex items-center justify-between px-1.5 pb-1.5">
        {/* Model selector */}
        <div>
          {providerModels && providerModels.length > 0 && onModelChange && (
            <>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    ref={modelButtonRef}
                    type="button"
                    onClick={() => setModelSelectorOpen(!modelSelectorOpen)}
                    className="flex items-center gap-0.5 rounded-md px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
                  >
                    <span className="truncate max-w-[140px]">
                      {selectedModelName}
                    </span>
                    <ChevronDown className="size-3 shrink-0" />
                  </button>
                </TooltipTrigger>
                <TooltipContent>
                  Switch model <Kbd>⌥/</Kbd>
                </TooltipContent>
              </Tooltip>
              <Combobox
                open={modelSelectorOpen}
                onOpenChange={(open) => {
                  setModelSelectorOpen(open);
                  if (!open) {
                    setHighlightedModelId(null);
                    setModelSearchQuery("");
                  }
                }}
                onInputValueChange={(value) => setModelSearchQuery(value)}
                value={selectedModel ?? ""}
                onValueChange={(val) => {
                  if (val) {
                    const info = modelIdToProvider.get(val);
                    if (info?.enabled) {
                      onModelChange(val);
                      setModelSelectorOpen(false);
                    }
                  }
                }}
                items={allModelItems}
                itemToStringLabel={(id) => modelIdToName.get(id) ?? id}
                autoHighlight
              >
                <ComboboxContent
                  side="top"
                  sideOffset={4}
                  anchor={modelButtonRef}
                  className="w-[320px] border border-border shadow-lg"
                >
                  <ComboboxInput
                    placeholder="Select a model..."
                    showTrigger={false}
                  />
                  <ComboboxList className="max-h-[300px] overflow-y-auto">
                    {pickerSections.favorites.length === 0 &&
                      pickerSections.recommended.length === 0 &&
                      pickerSections.providers.length === 0 && (
                        <div className="flex w-full justify-center py-2 text-center text-sm text-muted-foreground">
                          No models found
                        </div>
                      )}

                    {pickerSections.favorites.length > 0 && (
                      <ComboboxGroup>
                        <ComboboxLabel className="sticky top-0 z-10 bg-popover/95 backdrop-blur-sm">
                          Favorites
                        </ComboboxLabel>
                        {pickerSections.favorites.map((model) => {
                          const compoundId = `${model.providerId}:${model.id}`;
                          return (
                            <Tooltip
                              key={compoundId}
                              open={highlightedModelId === compoundId}
                            >
                              <TooltipTrigger asChild>
                                <ComboboxItem
                                  value={compoundId}
                                  disabled={!model.enabled}
                                  onPointerMove={() =>
                                    setHighlightedModelId(compoundId)
                                  }
                                  onFocus={() =>
                                    setHighlightedModelId(compoundId)
                                  }
                                >
                                  <RegistryIcon
                                    id={model.providerId}
                                    className="size-1.5 mr-1.5 shrink-0"
                                  />
                                  <span className="flex-1 truncate">
                                    {model.name}
                                  </span>
                                  <button
                                    type="button"
                                    onClick={(e) => {
                                      e.preventDefault();
                                      e.stopPropagation();
                                      onFavoriteToggle?.(compoundId);
                                    }}
                                    className="order-last ml-2 text-primary hover:scale-110 transition-transform"
                                  >
                                    <Star className="size-3.5 fill-current" />
                                  </button>
                                </ComboboxItem>
                              </TooltipTrigger>
                              <TooltipContent
                                side="right"
                                sideOffset={12}
                                hideArrow
                                className="max-w-none w-auto p-3 bg-popover text-popover-foreground border border-border shadow-lg"
                              >
                                <ModelInfoContent model={model} />
                              </TooltipContent>
                            </Tooltip>
                          );
                        })}
                      </ComboboxGroup>
                    )}

                    {pickerSections.recommended.length > 0 && (
                      <ComboboxGroup>
                        <ComboboxLabel className="sticky top-0 z-10 bg-popover/95 backdrop-blur-sm">
                          Recommended
                        </ComboboxLabel>
                        {pickerSections.recommended.map((model) => {
                          const compoundId = `${model.providerId}:${model.id}`;
                          return (
                            <Tooltip
                              key={compoundId}
                              open={highlightedModelId === compoundId}
                            >
                              <TooltipTrigger asChild>
                                <ComboboxItem
                                  value={compoundId}
                                  disabled={!model.enabled}
                                  onPointerMove={() =>
                                    setHighlightedModelId(compoundId)
                                  }
                                  onFocus={() =>
                                    setHighlightedModelId(compoundId)
                                  }
                                >
                                  <RegistryIcon
                                    id={model.providerId}
                                    className="size-[10px] mr-1.5 shrink-0 opacity-60 grayscale"
                                  />
                                  <span className="flex-1 truncate">
                                    {model.name}
                                  </span>
                                  <button
                                    type="button"
                                    onClick={(e) => {
                                      e.preventDefault();
                                      e.stopPropagation();
                                      onFavoriteToggle?.(compoundId);
                                    }}
                                    className="order-last ml-2 text-muted-foreground hover:text-primary transition-colors"
                                  >
                                    <Star className="size-3.5" />
                                  </button>
                                </ComboboxItem>
                              </TooltipTrigger>
                              <TooltipContent
                                side="right"
                                sideOffset={12}
                                hideArrow
                                className="max-w-none w-auto p-3 bg-popover text-popover-foreground border border-border shadow-lg"
                              >
                                <ModelInfoContent model={model} />
                              </TooltipContent>
                            </Tooltip>
                          );
                        })}
                      </ComboboxGroup>
                    )}

                    {pickerSections.providers.map((group) => (
                      <ComboboxGroup key={group.provider}>
                        <ComboboxLabel className="sticky top-0 z-10 bg-popover/95 backdrop-blur-sm">
                          {group.label}
                        </ComboboxLabel>
                        {group.models.map((model) => {
                          const compoundId = `${group.provider}:${model.id}`;
                          const isFavorite =
                            favoriteModels.includes(compoundId);
                          return (
                            <Tooltip
                              key={compoundId}
                              open={highlightedModelId === compoundId}
                            >
                              <TooltipTrigger asChild>
                                <ComboboxItem
                                  value={compoundId}
                                  disabled={!group.enabled}
                                  onPointerMove={() =>
                                    setHighlightedModelId(compoundId)
                                  }
                                  onFocus={() =>
                                    setHighlightedModelId(compoundId)
                                  }
                                >
                                  <RegistryIcon
                                    id={group.provider}
                                    className="size-[10px] mr-1.5 shrink-0 opacity-60 grayscale"
                                  />
                                  <span className="flex-1 truncate">
                                    {model.name}
                                  </span>
                                  {!group.enabled && (
                                    <span className="text-[10px] text-muted-foreground mr-2">
                                      Not configured
                                    </span>
                                  )}
                                  <button
                                    type="button"
                                    onClick={(e) => {
                                      e.preventDefault();
                                      e.stopPropagation();
                                      onFavoriteToggle?.(compoundId);
                                    }}
                                    className={`order-last ml-2 transition-colors ${isFavorite ? "text-primary" : "text-transparent group-hover/command-item:text-muted-foreground hover:!text-primary"}`}
                                  >
                                    <Star
                                      className={`size-3.5 ${isFavorite ? "fill-current" : ""}`}
                                    />
                                  </button>
                                </ComboboxItem>
                              </TooltipTrigger>
                              <TooltipContent
                                side="right"
                                sideOffset={12}
                                hideArrow
                                className="max-w-none w-auto p-3 bg-popover text-popover-foreground border border-border shadow-lg"
                              >
                                <ModelInfoContent model={model} />
                              </TooltipContent>
                            </Tooltip>
                          );
                        })}
                      </ComboboxGroup>
                    ))}
                  </ComboboxList>

                  <div className="p-1 border-t border-border mt-1">
                    <button
                      type="button"
                      onClick={() => {
                        setModelSelectorOpen(false);
                        chrome.tabs.create({
                          url: chrome.runtime.getURL(
                            "/settings.html?tab=models",
                          ),
                        });
                      }}
                    className="w-full flex items-center justify-center gap-2 rounded-sm px-2 py-1 text-xs outline-hidden select-none hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
                  >
                    Configure <Kbd className="ml-1 text-[10px] h-4 py-0">⌥⇧C</Kbd>
                  </button>
                  </div>

                  {selectedModelCapabilities?.includes("thinking") && (
                    <div className="flex items-center gap-2 px-2 py-1.5 border-t border-border">
                      <BrainIcon className="size-3.5 shrink-0 text-muted-foreground" />
                      <Switch
                        checked={thinkingEnabled ?? false}
                        onCheckedChange={(checked) => {
                          if (checked) {
                            const defaultConfig = getDefaultThinkingConfig(
                              selectedModel ?? "",
                            );
                            onThinkingChange?.(true, defaultConfig);
                          } else {
                            onThinkingChange?.(false, undefined);
                          }
                        }}
                        className="scale-75 origin-left"
                      />
                      {thinkingEnabled ? (
                        <ThinkingControl
                          config={thinkingConfig}
                          modelId={selectedModel ?? ""}
                          onChange={(config) =>
                            onThinkingChange?.(true, config)
                          }
                        />
                      ) : (
                        <span className="text-xs text-muted-foreground">
                          Thinking
                        </span>
                      )}
                    </div>
                  )}
                </ComboboxContent>
              </Combobox>
            </>
          )}
        </div>

        {/* Action buttons */}
        <div className="flex items-center gap-1.5">
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={(e) => {
              if (e.target.files) {
                addFiles(e.target.files);
                e.target.value = "";
              }
            }}
          />
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={disabled}
                className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-40"
              >
                <Paperclip className="size-3.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="top" className="flex items-center gap-1.5">
              Attach files or images <Kbd>⌘U</Kbd>
            </TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={handleButtonClick}
                disabled={
                  buttonMode === "send" && (disabled || !hasContent)
                  || (buttonMode === "queue" && !hasContent)
                }
                className="flex size-7 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-40"
              >
                {buttonMode === "stop" && <Square className="size-3" />}
                {buttonMode === "queue" && <Plus className="size-3.5" />}
                {buttonMode === "send" && <ArrowUp className="size-3.5" />}
              </button>
            </TooltipTrigger>
            <TooltipContent side="top" className="flex items-center gap-1.5">
              {buttonMode === "stop" && (
                <>
                  Stop
                  <Kbd>⌘⇧⌫</Kbd>
                </>
              )}
              {buttonMode === "queue" && (
                <>
                  Queue
                  <Kbd>⏎</Kbd>
                </>
              )}
              {buttonMode === "send" &&
                (editMode ? (
                  <>
                    Save
                    <Kbd>⏎</Kbd>
                  </>
                ) : (
                  "Send"
                ))}
            </TooltipContent>
          </Tooltip>
        </div>
      </div>

      {isDragOver && (
        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-lg bg-card/85 backdrop-blur-sm">
          <div className="flex flex-col items-center gap-1.5 text-blue-500">
            <Paperclip className="size-5" />
            <span className="text-xs font-medium">Drop file to attach</span>
          </div>
        </div>
      )}
    </div>
  );
}

function getProviderType(
  modelId: string,
): "anthropic" | "openai" | "google" | "other" {
  if (modelId.startsWith("claude-")) return "anthropic";
  if (modelId.startsWith("gpt-") || modelId.startsWith("o")) return "openai";
  if (modelId.startsWith("gemini-")) return "google";
  return "other";
}

function getBudgetRange(modelId: string): {
  min: number;
  max: number;
  step: number;
  default: number;
} {
  const provider = getProviderType(modelId);
  if (provider === "google") {
    if (modelId.includes("flash"))
      return { min: 0, max: 24_576, step: 512, default: 8192 };
    return { min: 128, max: 32_768, step: 512, default: 10000 };
  }
  // Anthropic: min 1024, max depends on model output limit
  if (modelId.includes("opus"))
    return { min: 1024, max: 128_000, step: 1024, default: 10000 };
  if (modelId.includes("sonnet"))
    return { min: 1024, max: 64_000, step: 1024, default: 10000 };
  if (modelId.includes("haiku"))
    return { min: 1024, max: 64_000, step: 1024, default: 8000 };
  return { min: 1024, max: 32_768, step: 1024, default: 10000 };
}

function getDefaultThinkingConfig(modelId: string): ThinkingConfig {
  const provider = getProviderType(modelId);
  if (provider === "openai") return { type: "effort", level: "medium" };
  const range = getBudgetRange(modelId);
  return { type: "budget", tokens: range.default };
}

function ThinkingControl({
  config,
  modelId,
  onChange,
}: {
  config?: ThinkingConfig;
  modelId: string;
  onChange: (config: ThinkingConfig) => void;
}) {
  const provider = getProviderType(modelId);

  if (provider === "openai") {
    const levels = ["minimal", "low", "medium", "high", "xhigh"];
    const current = config?.type === "effort" ? config.level : "medium";
    return (
      <select
        value={current}
        onChange={(e) => onChange({ type: "effort", level: e.target.value })}
        className="h-6 rounded border border-border bg-background px-1.5 text-xs text-foreground outline-none"
      >
        {levels.map((l) => (
          <option key={l} value={l}>
            {l}
          </option>
        ))}
      </select>
    );
  }

  const range = getBudgetRange(modelId);
  const tokens = config?.type === "budget" ? config.tokens : range.default;
  return (
    <div className="flex items-center gap-2 flex-1 min-w-0">
      <Slider
        value={[tokens]}
        onValueChange={([v]) => onChange({ type: "budget", tokens: v })}
        min={range.min}
        max={range.max}
        step={range.step}
        className="flex-1"
      />
      <span className="text-[10px] text-muted-foreground whitespace-nowrap w-10 text-right">
        {tokens >= 1000 ? `${Math.round(tokens / 1000)}k` : tokens}
      </span>
    </div>
  );
}

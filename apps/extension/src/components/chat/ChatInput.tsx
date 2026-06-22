import { NoAutoLink } from "@/components/tiptap/link-extension";
import { SkillSlash } from "@/components/tiptap/skill-slash-extension";
import {
    extractSlashCommands,
    stripSlashCommandNodes,
} from "@/components/tiptap/slash-command-extract";
import { TabMention } from "@/components/tiptap/tab-mention-extension";
import { Kbd, KbdGroup } from "@/components/ui/kbd";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import {
    Tooltip,
    TooltipContent,
    TooltipTrigger,
} from "@/components/ui/tooltip";
import { ZoomableImage } from "@/components/ui/zoomable-image";
import {
    isGemini3Model,
    isGeminiFlashModel,
    resolveThinkingVendor,
} from "@/lib/agent/thinking";
import { getImageSizeLimit } from "@/lib/agent/vision-limits";
import {
    countLines,
    formatBytes,
    getTypeBadge,
    isTextFile,
} from "@/lib/chat/attachment-meta";
import type { Attachment } from "@/lib/chat/types";
import { openSettingsTab } from "@/lib/open-settings";
import type { ConversationMode, ThinkingConfig } from "@/lib/types";
import { cn } from "@/lib/utils";
import type { JSONContent } from "@tiptap/core";
import HardBreak from "@tiptap/extension-hard-break";
import Placeholder from "@tiptap/extension-placeholder";
import { Markdown } from "@tiptap/markdown";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import {
    ArrowUp,
    BrainIcon,
    Paperclip,
    Plus,
    Square,
    X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useHotkeys } from "react-hotkeys-hook";
import { toast } from "sonner";
import { computeButtonMode } from "./chat-input-mode";
import {
    ModelPicker,
    type ModelOption,
    type ProviderModels,
} from "./ModelPicker";
import { ModeSwitch } from "./ModeSwitch";

// Derived alias kept for back-compat with call sites that destructure
// images: ImagePreview[] from onSubmit. Tasks 5-6 migrate those sites;
// once they're gone we can delete the alias and the re-export.
type ImagePreview = Extract<Attachment, { kind: "image" }>;

/**
 * Composer placeholder shown when an AI model is configured. Defined once
 * and used in BOTH the Placeholder extension config and the `disabled`
 * toggle effect, so the two never drift (the toggle effect previously
 * reset it to a stale string, dropping the "/ for skills & commands" hint).
 */
const COMPOSER_PLACEHOLDER =
  "Ask anything... Type @ to mention a tab, / for skills & commands";

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
   * Optional handler for built-in slash commands (e.g. `/compact`).
   *
   * When the submitted message contains a built-in command node, the
   * command is stripped from the editor, `onChange` is called with the
   * remaining text, and this handler runs *instead of* `onSubmit`. The
   * host decides what to do — for `/compact` that means running a manual
   * compaction and, when `hasRemaining` is true, sending the leftover
   * text to the agent afterwards (compact-then-send).
   *
   * `hasRemaining` is true when, after removing the command node(s),
   * there is still sendable content (non-whitespace text, a tab mention,
   * or a non-command skill slash).
   */
  onCommand?: (payload: {
    command: string;
    hasRemaining: boolean;
    mentions: TabMentionAttrs[];
    attachments: Attachment[];
  }) => void;
  /**
   * When true, the input is being used to edit an existing message
   * (either a sent message or a queued one). The primary button is
   * forced to "Save" mode regardless of `isLoading`, and Enter commits
   * via `onSubmit` instead of branching into queue/stop.
   *
   * The Esc-Esc stop hotkey is preserved (it reads
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
  /**
   * Per-conversation approval mode picker. When BOTH props are provided
   * the mode dropdown renders next to the model picker. The parent
   * (ChatView) reads `Conversation.mode` from chatDb and persists changes
   * via `chatDb.updateConversation`.
   *
   * Pre-conversation surfaces (e.g. LandingPage) omit these to hide the
   * picker entirely.
   */
  mode?: ConversationMode;
  onModeChange?: (mode: ConversationMode) => void;
  /**
   * True when the conversation has an approved plan. Forwarded to
   * ModeSwitch so the trigger can indicate "plan approved" vs "plan
   * mode but no plan yet".
   */
  hasPlan?: boolean;
}

export interface TabMentionAttrs {
  title: string;
  url: string;
  favicon: string;
}

export type { Attachment, ImagePreview };

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
                {cap === "computer-use" ? "Computer Use" : cap}
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
  onCommand,
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
  mode,
  onModeChange,
  hasPlan,
}: ChatInputProps) {
  const onSubmitRef = useRef(onSubmit);
  onSubmitRef.current = onSubmit;
  const onQueueRef = useRef(onQueue);
  onQueueRef.current = onQueue;
  const onStopRef = useRef(onStop);
  onStopRef.current = onStop;
  const onCommandRef = useRef(onCommand);
  onCommandRef.current = onCommand;
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

    // Built-in slash commands (e.g. `/compact`) are intercepted here:
    // they run a local action via `onCommand` instead of being sent to
    // the agent as message text. We strip the command node from the
    // editor first so any leftover text is what the host sends (the
    // "compact-then-send" flow), and so re-submitting can't resurrect
    // the command.
    const commands = extractSlashCommands(json);
    const handler = onCommandRef.current;
    if (commands.length > 0 && handler) {
      const { json: stripped, hasRemaining } = stripSlashCommandNodes(json);
      // Capture the attachments before we clear them — the host may want
      // to send them along with any remaining text.
      const attachments = attachmentsRef.current;

      if (hasRemaining) {
        // Replace the editor content with the command-free doc. This
        // fires onUpdate → onChange, keeping the host's `value`/`input`
        // state in sync so a follow-up submit sends the leftover text.
        ed.commands.setContent(stripped);
      } else {
        ed.commands.clearContent();
        onChange("");
        lastExternalValue.current = "";
      }
      setAttachments([]);

      // Fire once per command in document order (only `compact` exists
      // today, but keep the loop general).
      for (const command of commands) {
        handler({ command, hasRemaining, mentions, attachments });
      }
      return;
    }

    onSubmitRef.current(mentions, attachmentsRef.current);
    setAttachments([]);
  }, [onChange]);

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
      // Drop StarterKit's bundled Link and use NoAutoLink instead, which
      // disables all URL auto-detection (autolink, linkOnPaste, and the
      // paste rule). Otherwise the Link paste rule wraps URL substrings
      // inside a pasted markdown link like
      // `[news.google.com](http://news.google.com)`, and getMarkdown()
      // re-emits each as `[...](...)`, nesting one layer per
      // copy/paste/resend cycle. NoAutoLink still parses/renders
      // deliberate markdown links so they round-trip and stay clickable.
      StarterKit.configure({
        hardBreak: false,
        dropcursor: false,
        link: false,
      }),
      NoAutoLink,
      Placeholder.configure({
        placeholder: COMPOSER_PLACEHOLDER,
        showOnlyWhenEditable: false,
      }),
      Markdown,
      HardBreak.extend({
        addKeyboardShortcuts() {
          return {
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

  // Press Esc twice within ~500ms to stop in-flight generation. A single
  // Escape is left alone so it can keep its default behavior (e.g. blurring
  // the Tiptap editor or dismissing popovers); only the second tap fires
  // `onStop`. Works in form fields and inside the chat editor's
  // contenteditable thanks to the flags below.
  //
  // While armed (between the two presses) we also surface a transient
  // "Press Esc again to interrupt" pill — see `escArmed` rendering below.
  // We mirror the state into a ref so the hotkey callback can read the
  // latest value without re-registering.
  const [escArmed, setEscArmed] = useState(false);
  const escArmedRef = useRef(false);
  escArmedRef.current = escArmed;
  const escArmTimerRef = useRef<number | null>(null);
  const disarmEsc = useCallback(() => {
    if (escArmTimerRef.current != null) {
      window.clearTimeout(escArmTimerRef.current);
      escArmTimerRef.current = null;
    }
    setEscArmed(false);
  }, []);
  useHotkeys(
    "escape",
    () => {
      // Only arm/fire while there's something to interrupt. This keeps a
      // single Escape press a no-op while idle, preserving default
      // browser/editor behavior.
      if (!isLoadingRef.current) {
        if (escArmedRef.current) disarmEsc();
        return;
      }
      if (escArmedRef.current) {
        disarmEsc();
        onStopRef.current?.();
        return;
      }
      setEscArmed(true);
      escArmTimerRef.current = window.setTimeout(() => {
        escArmTimerRef.current = null;
        setEscArmed(false);
      }, 500);
    },
    { enableOnFormTags: true, enableOnContentEditable: true },
  );

  // If the agent finishes (or is otherwise no longer loading) while we're
  // armed, disarm so the hint disappears immediately and a stray second
  // Escape doesn't fire `onStop` against a non-loading state.
  useEffect(() => {
    if (!isLoading && escArmed) disarmEsc();
  }, [isLoading, escArmed, disarmEsc]);

  // Clean up the pending timer on unmount.
  useEffect(() => {
    return () => {
      if (escArmTimerRef.current != null) {
        window.clearTimeout(escArmTimerRef.current);
      }
    };
  }, []);

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
        void openSettingsTab("models");
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
          : COMPOSER_PLACEHOLDER;
      }
    });
    editor.view.dispatch(editor.state.tr);
    if (!disabled && autoFocus) {
      editor.commands.focus("end");
    }
  }, [editor, disabled, autoFocus]);

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
      {/* Transient hint shown after the first Esc press while the agent
          is streaming. Floats just above the composer, centered, so it
          reads naturally regardless of where focus is. Auto-dismisses
          with the armed state (~500ms or as soon as we stop / fire onStop). */}
      {escArmed && isLoading && (
        <div
          role="status"
          aria-live="polite"
          className="pointer-events-none absolute -top-7 left-1/2 z-20 flex -translate-x-1/2 items-center gap-1.5 rounded-md bg-foreground/90 px-2 py-1 text-[11px] text-background shadow-sm animate-in fade-in-0 slide-in-from-bottom-1 duration-150"
        >
          Press <Kbd>Esc</Kbd> again to interrupt
        </div>
      )}
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
        {/* Model selector + mode switch */}
        <div className="flex items-center gap-1">
          {providerModels && providerModels.length > 0 && onModelChange && (
            <ModelPicker
              trigger="chat"
              providerModels={providerModels}
              value={selectedModel}
              onValueChange={onModelChange}
              favoriteModels={favoriteModels}
              onFavoriteToggle={onFavoriteToggle}
              showRecommended
              placeholder="Select a model..."
              open={modelSelectorOpen}
              onOpenChange={setModelSelectorOpen}
              triggerTooltip={
                <>
                  Switch model <Kbd>⌥/</Kbd>
                </>
              }
              renderModelInfo={(model) => <ModelInfoContent model={model} />}
              footer={
                <div className="p-1 border-t border-border mt-1">
                  <button
                    type="button"
                    onClick={() => {
                      setModelSelectorOpen(false);
                      void openSettingsTab("models");
                    }}
                    className="w-full flex items-center justify-center gap-2 rounded-sm px-2 py-1 text-xs outline-hidden select-none hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
                  >
                    Configure{" "}
                    <Kbd className="ml-1 text-[10px] h-4 py-0">⌥⇧C</Kbd>
                  </button>
                </div>
              }
              footerExtra={
                selectedModelCapabilities?.includes("thinking") ? (
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
                        onChange={(config) => onThinkingChange?.(true, config)}
                      />
                    ) : (
                      <span className="text-xs text-muted-foreground">
                        Thinking
                      </span>
                    )}
                  </div>
                ) : null
              }
            />
          )}
          {mode && onModeChange && (
            <ModeSwitch mode={mode} onChange={onModeChange} hasPlan={hasPlan} />
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
                  <KbdGroup>
                    <Kbd>Esc</Kbd>
                  </KbdGroup>
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

/**
 * Split a compound `"<providerId>:<modelId>"` (the form stored in
 * `agentSettings.agentModel`) into its parts. Legacy flat ids (no provider
 * segment) yield an empty provider id and the whole string as the model id.
 */
function splitCompoundModelId(compound: string): {
  providerId: string;
  modelId: string;
} {
  const idx = compound.indexOf(":");
  if (idx < 0) return { providerId: "", modelId: compound };
  return {
    providerId: compound.slice(0, idx),
    modelId: compound.slice(idx + 1),
  };
}

/**
 * Resolve the thinking vendor from the compound model id the UI carries.
 * Handles both direct providers and gateway-routed `vendor/model` ids. Returns
 * `"other"` when the vendor is unknown.
 */
function getProviderType(
  compoundModelId: string,
): "anthropic" | "openai" | "google" | "other" {
  const { providerId, modelId } = splitCompoundModelId(compoundModelId);
  return resolveThinkingVendor(providerId, modelId) ?? "other";
}

/** Gemini 3 thinking levels (flash adds `minimal`). */
function getGemini3Levels(compoundModelId: string): string[] {
  const { modelId } = splitCompoundModelId(compoundModelId);
  return isGeminiFlashModel(modelId)
    ? ["minimal", "low", "medium", "high"]
    : ["low", "medium", "high"];
}

/** True when the (compound) model is a Gemini 3 model using `thinkingLevel`. */
function isGemini3Compound(compoundModelId: string): boolean {
  const { modelId } = splitCompoundModelId(compoundModelId);
  return isGemini3Model(modelId);
}

function getBudgetRange(compoundModelId: string): {
  min: number;
  max: number;
  step: number;
  default: number;
} {
  const provider = getProviderType(compoundModelId);
  const { modelId } = splitCompoundModelId(compoundModelId);
  if (provider === "google") {
    if (isGeminiFlashModel(modelId))
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

function getDefaultThinkingConfig(compoundModelId: string): ThinkingConfig {
  const provider = getProviderType(compoundModelId);
  if (provider === "openai") return { type: "effort", level: "medium" };
  // Gemini 3 uses an effort-style level (mapped to `thinkingLevel` at the
  // transport). Everything else (Gemini 2.5, Anthropic) uses a token budget.
  if (provider === "google" && isGemini3Compound(compoundModelId))
    return { type: "effort", level: "medium" };
  const range = getBudgetRange(compoundModelId);
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

  // Effort/level dropdown: OpenAI (reasoning effort) and Gemini 3
  // (thinkingLevel). Both persist as `{ type: "effort"; level }`.
  const isGemini3 = provider === "google" && isGemini3Compound(modelId);
  if (provider === "openai" || isGemini3) {
    const levels = isGemini3
      ? getGemini3Levels(modelId)
      : ["minimal", "low", "medium", "high", "xhigh"];
    const fallback = levels.includes("medium") ? "medium" : levels[0];
    const current =
      config?.type === "effort" && levels.includes(config.level)
        ? config.level
        : fallback;
    return (
      <Select
        value={current}
        onValueChange={(level) => onChange({ type: "effort", level })}
      >
        <SelectTrigger size="sm" className="h-6 text-xs capitalize">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {levels.map((l) => (
            <SelectItem key={l} value={l} className="text-xs capitalize">
              {l}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
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

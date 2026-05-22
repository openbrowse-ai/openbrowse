import { TabMention } from "@/components/tiptap/tab-mention-extension";
import { SkillSlash } from "@/components/tiptap/skill-slash-extension";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";
import { Markdown } from "@tiptap/markdown";
import HardBreak from "@tiptap/extension-hard-break";
import { ArrowUp, Image as ImageIcon, Square, X, ChevronDown, BrainIcon, Star } from "lucide-react";
import { useEffect, useCallback, useRef, useState, useMemo } from "react";
import { useHotkeys } from "react-hotkeys-hook";
import type { JSONContent } from "@tiptap/core";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Kbd } from "@/components/ui/kbd";
import { Switch } from "@/components/ui/switch";
import { Slider } from "@/components/ui/slider";
import type { ThinkingConfig } from "@/lib/types";
import {
  Combobox,
  ComboboxContent,
  ComboboxInput,
  ComboboxList,
  ComboboxItem,
  ComboboxGroup,
  ComboboxLabel,
  ComboboxEmpty,
  ComboboxCollection,
} from "@/components/ui/combobox";
import { RegistryIcon } from "@/components/ui/registry-icon";

interface ImagePreview {
  id: string;
  file: File;
  dataUrl: string;
}

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
  onSubmit: (mentions: TabMentionAttrs[], images: ImagePreview[]) => void;
  onStop?: () => void;
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

export type { ImagePreview };

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


export async function fetchTabContent(
  url: string,
): Promise<{ title: string; h1: string; description: string; bodyText: string } | null> {
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
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`;
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
            <span className="opacity-100">{formatTokenCount(model.contextWindow)} tokens</span>
          </div>
        )}
        {model.maxOutputTokens && (
          <div className="flex justify-between">
            <span>Max output</span>
            <span className="opacity-100">{formatTokenCount(model.maxOutputTokens)} tokens</span>
          </div>
        )}
        {model.pricing && (
          <>
            <div className="flex justify-between">
              <span>Input pricing</span>
              <span className="opacity-100">${model.pricing.inputPer1M} / 1M</span>
            </div>
            <div className="flex justify-between">
              <span>Output pricing</span>
              <span className="opacity-100">${model.pricing.outputPer1M} / 1M</span>
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
              <span key={cap} className="rounded bg-foreground/10 px-1.5 py-0.5 text-[10px] capitalize">
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
  onStop,
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
  const onStopRef = useRef(onStop);
  onStopRef.current = onStop;
  const isLoadingRef = useRef(isLoading);
  isLoadingRef.current = isLoading;
  const editorRef = useRef<ReturnType<typeof useEditor>>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [images, setImages] = useState<ImagePreview[]>([]);
  const imagesRef = useRef(images);
  imagesRef.current = images;
  const lastExternalValue = useRef(value);
  const [modelSelectorOpen, setModelSelectorOpen] = useState(false);
  const [highlightedModelId, setHighlightedModelId] = useState<string | null>(null);
  const [modelSearchQuery, setModelSearchQuery] = useState("");
  const modelButtonRef = useRef<HTMLButtonElement>(null);

  const allModelItems = useMemo(() => {
    if (!providerModels) return [];
    return providerModels.flatMap((g) => g.models.map((m) => `${g.provider}:${m.id}`));
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
        map.set(`${group.provider}:${m.id}`, { provider: group.provider, enabled: group.enabled });
      }
    }
    return map;
  }, [providerModels]);

  const pickerSections = useMemo(() => {
    if (!providerModels) return { favorites: [], recommended: [], providers: [] };
    const q = modelSearchQuery.toLowerCase().trim();
    
    // Helper to filter models
    const filterModels = (models: typeof providerModels[0]['models'], groupLabel: string) => {
      if (!q) return models;
      return models.filter((m) => m.name.toLowerCase().includes(q) || groupLabel.toLowerCase().includes(q));
    };

    // 1. Favorites
    const favoriteItems: Array<typeof providerModels[0]['models'][0] & { providerId: string; providerLabel: string; enabled: boolean }> = [];
    // 2. Recommended
    const recommendedItems: typeof favoriteItems = [];
    
    // We will collect all models into these arrays
    for (const group of providerModels) {
      const models = filterModels(group.models, group.label);
      for (const m of models) {
        const item = { ...m, providerId: group.provider, providerLabel: group.label, enabled: group.enabled };
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

  const addFiles = useCallback(async (files: FileList | File[]) => {
    const imageFiles = Array.from(files).filter((f) => f.type.startsWith("image/"));
    if (imageFiles.length === 0) return;

    const newPreviews = await Promise.all(
      imageFiles.map(async (file) => ({
        id: crypto.randomUUID(),
        file,
        dataUrl: await fileToDataUrl(file),
      })),
    );
    setImages((prev) => [...prev, ...newPreviews]);
  }, []);

  const removeImage = useCallback((id: string) => {
    setImages((prev) => prev.filter((img) => img.id !== id));
  }, []);

  const submitWithMentions = useCallback(() => {
    const ed = editorRef.current;
    if (!ed) return;
    const json = ed.getJSON();
    const mentions = extractTabMentions(json);
    onSubmitRef.current(mentions, imagesRef.current);
    setImages([]);
  }, []);

  const editor = useEditor({
    autofocus: autoFocus ? "end" : false,
    extensions: [
      StarterKit.configure({ hardBreak: false }),
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
              if (isLoadingRef.current && onStopRef.current) {
                onStopRef.current();
              } else {
                const text = this.editor.getMarkdown().trim();
                if (text || imagesRef.current.length > 0) {
                  submitWithMentions();
                }
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
          const hasImages = Array.from(files).some((f) => f.type.startsWith("image/"));
          if (hasImages) {
            event.preventDefault();
            addFiles(files);
            return true;
          }
        }
        return false;
      },
      handleDrop: (_view, event) => {
        const files = event.dataTransfer?.files;
        if (files && files.length > 0) {
          const hasImages = Array.from(files).some((f) => f.type.startsWith("image/"));
          if (hasImages) {
            event.preventDefault();
            addFiles(files);
            return true;
          }
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

  const handleButtonClick = useCallback(() => {
    if (isLoading && onStop) {
      onStop();
    } else if ((value.trim() || images.length > 0) && !disabled && !isLoading) {
      submitWithMentions();
    }
  }, [isLoading, onStop, value, disabled, submitWithMentions, images.length]);

  useHotkeys("mod+shift+backspace", () => {
    if (isLoadingRef.current && onStopRef.current) {
      onStopRef.current();
    }
  }, { enableOnFormTags: true });

  useEffect(() => {
    function handleAltSlash(e: KeyboardEvent) {
      if (e.altKey && (e.key === "/" || e.code === "Slash")) {
        e.preventDefault();
        setModelSelectorOpen((prev) => !prev);
      }
    }
    document.addEventListener("keydown", handleAltSlash, true);
    return () => document.removeEventListener("keydown", handleAltSlash, true);
  }, []);

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
    const actualModelId = modelIdParts.length > 0 ? modelIdParts.join(":") : selectedModel;
    for (const group of providerModels) {
      if (modelIdParts.length > 0 && group.provider !== providerId) continue;
      const found = group.models.find((m) => m.id === actualModelId);
      if (found) return found.name;
    }
    return actualModelId;
  }, [providerModels, selectedModel]);

  return (
    <div className="flex flex-col rounded-lg border border-border bg-card">
      {/* Image previews */}
      {images.length > 0 && (
        <div className="flex flex-wrap gap-1.5 px-2 pt-2">
          {images.map((img) => (
            <div key={img.id} className="relative group">
              <img
                src={img.dataUrl}
                alt="Upload preview"
                className="size-16 object-cover rounded-md border border-border"
              />
              <button
                type="button"
                onClick={() => removeImage(img.id)}
                className="absolute -right-1 -top-1 size-4 flex items-center justify-center rounded-full bg-background border border-border shadow-sm opacity-0 group-hover:opacity-100 transition-opacity"
              >
                <X className="size-2.5" />
              </button>
            </div>
          ))}
        </div>
      )}

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
                    <span className="truncate max-w-[140px]">{selectedModelName}</span>
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
              <ComboboxContent side="top" sideOffset={4} anchor={modelButtonRef} className="w-[320px] border border-border shadow-lg">
                <ComboboxInput placeholder="Search models..." showTrigger={false} />
                <ComboboxList className="max-h-[300px] overflow-y-auto">
                  {pickerSections.favorites.length === 0 && pickerSections.recommended.length === 0 && pickerSections.providers.length === 0 && (
                    <div className="flex w-full justify-center py-2 text-center text-sm text-muted-foreground">No models found</div>
                  )}

                  {pickerSections.favorites.length > 0 && (
                    <ComboboxGroup>
                      <ComboboxLabel className="sticky top-0 z-10 bg-popover/95 backdrop-blur-sm">Favorites</ComboboxLabel>
                      {pickerSections.favorites.map((model) => {
                        const compoundId = `${model.providerId}:${model.id}`;
                        return (
                          <Tooltip key={compoundId} open={highlightedModelId === compoundId}>
                            <TooltipTrigger asChild>
                              <ComboboxItem
                                value={compoundId}
                                disabled={!model.enabled}
                                onPointerMove={() => setHighlightedModelId(compoundId)}
                                onFocus={() => setHighlightedModelId(compoundId)}
                              >
                                <RegistryIcon id={model.providerId} className="size-3.5 mr-1" />
                                <span className="flex-1 truncate">{model.name}</span>
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
                            <TooltipContent side="right" sideOffset={12} hideArrow className="max-w-none w-auto p-3 bg-popover text-popover-foreground border border-border shadow-lg">
                              <ModelInfoContent model={model} />
                            </TooltipContent>
                          </Tooltip>
                        );
                      })}
                    </ComboboxGroup>
                  )}

                  {pickerSections.recommended.length > 0 && (
                    <ComboboxGroup>
                      <ComboboxLabel className="sticky top-0 z-10 bg-popover/95 backdrop-blur-sm">Recommended</ComboboxLabel>
                      {pickerSections.recommended.map((model) => {
                        const compoundId = `${model.providerId}:${model.id}`;
                        return (
                          <Tooltip key={compoundId} open={highlightedModelId === compoundId}>
                            <TooltipTrigger asChild>
                              <ComboboxItem
                                value={compoundId}
                                disabled={!model.enabled}
                                onPointerMove={() => setHighlightedModelId(compoundId)}
                                onFocus={() => setHighlightedModelId(compoundId)}
                              >
                                <RegistryIcon id={model.providerId} className="size-3.5 mr-1 text-muted-foreground opacity-50" />
                                <span className="flex-1 truncate">{model.name}</span>
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
                            <TooltipContent side="right" sideOffset={12} hideArrow className="max-w-none w-auto p-3 bg-popover text-popover-foreground border border-border shadow-lg">
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
                        <span className="flex items-center gap-1.5">
                          <RegistryIcon id={group.provider} className="size-3.5" />
                          {group.label}
                        </span>
                      </ComboboxLabel>
                      {group.models.map((model) => {
                        const compoundId = `${group.provider}:${model.id}`;
                        const isFavorite = favoriteModels.includes(compoundId);
                        return (
                          <Tooltip key={compoundId} open={highlightedModelId === compoundId}>
                            <TooltipTrigger asChild>
                              <ComboboxItem
                                value={compoundId}
                                disabled={!group.enabled}
                                onPointerMove={() => setHighlightedModelId(compoundId)}
                                onFocus={() => setHighlightedModelId(compoundId)}
                              >
                                <span className="flex-1 truncate">{model.name}</span>
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
                                  <Star className={`size-3.5 ${isFavorite ? "fill-current" : ""}`} />
                                </button>
                              </ComboboxItem>
                            </TooltipTrigger>
                            <TooltipContent side="right" sideOffset={12} hideArrow className="max-w-none w-auto p-3 bg-popover text-popover-foreground border border-border shadow-lg">
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
                      chrome.tabs.create({ url: chrome.runtime.getURL("/settings.html?tab=models") });
                    }}
                    className="w-full flex items-center justify-center gap-2 rounded-sm px-2 py-1 text-xs outline-hidden select-none hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
                  >
                    Configure <Kbd className="ml-1 text-[10px] h-4 py-0">⌥⌘C</Kbd>
                  </button>
                </div>

                {selectedModelCapabilities?.includes("thinking") && (
                  <div className="flex items-center gap-2 px-2 py-1.5 border-t border-border">
                    <BrainIcon className="size-3.5 shrink-0 text-muted-foreground" />
                    <Switch
                      checked={thinkingEnabled ?? false}
                      onCheckedChange={(checked) => {
                        if (checked) {
                          const defaultConfig = getDefaultThinkingConfig(selectedModel ?? "");
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
                      <span className="text-xs text-muted-foreground">Thinking</span>
                    )}
                  </div>
                )}
              </ComboboxContent>
            </Combobox>
            </>
          )}
        </div>

        {/* Action buttons */}
        <div className="flex items-center gap-0.5">
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
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
                <ImageIcon className="size-3.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="top">Attach image</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={handleButtonClick}
                disabled={disabled && !isLoading}
                className="flex size-7 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-40"
              >
                {isLoading ? <Square className="size-3" /> : <ArrowUp className="size-3.5" />}
              </button>
            </TooltipTrigger>
            <TooltipContent side="top" className="flex items-center gap-1.5">
              {isLoading ? (
                <>
                  Stop
                  <Kbd>⌘⇧⌫</Kbd>
                </>
              ) : "Send"}
            </TooltipContent>
          </Tooltip>
        </div>
      </div>
    </div>
  );
}

function getProviderType(modelId: string): "anthropic" | "openai" | "google" | "other" {
  if (modelId.startsWith("claude-")) return "anthropic";
  if (modelId.startsWith("gpt-") || modelId.startsWith("o")) return "openai";
  if (modelId.startsWith("gemini-")) return "google";
  return "other";
}

function getBudgetRange(modelId: string): { min: number; max: number; step: number; default: number } {
  const provider = getProviderType(modelId);
  if (provider === "google") {
    if (modelId.includes("flash")) return { min: 0, max: 24_576, step: 512, default: 8192 };
    return { min: 128, max: 32_768, step: 512, default: 10000 };
  }
  // Anthropic: min 1024, max depends on model output limit
  if (modelId.includes("opus")) return { min: 1024, max: 128_000, step: 1024, default: 10000 };
  if (modelId.includes("sonnet")) return { min: 1024, max: 64_000, step: 1024, default: 10000 };
  if (modelId.includes("haiku")) return { min: 1024, max: 64_000, step: 1024, default: 8000 };
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
          <option key={l} value={l}>{l}</option>
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

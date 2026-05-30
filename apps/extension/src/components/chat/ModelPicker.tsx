import {
  Combobox,
  ComboboxContent,
  ComboboxGroup,
  ComboboxInput,
  ComboboxItem,
  ComboboxLabel,
  ComboboxList,
  ComboboxTrigger,
} from "@/components/ui/combobox";
import { RegistryIcon } from "@/components/ui/registry-icon";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Star } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";

export interface ModelOption {
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

export interface ProviderModels {
  provider: string;
  label: string;
  models: ModelOption[];
  enabled: boolean;
}

/**
 * A leading non-model option (e.g. "Same as agent model") rendered at
 * the top of the list. Selecting it calls `onValueChange(value)`.
 */
export interface ModelPickerDefaultOption {
  value: string;
  label: string;
}

interface ModelPickerProps {
  providerModels: ProviderModels[];
  /** Current selection — a `provider:modelId` compound id, the
   * `defaultOption.value` sentinel, or undefined when unset. */
  value: string | undefined;
  onValueChange: (value: string) => void;

  /**
   * When provided, renders a Favorites section (and per-row star
   * toggles). Omit in surfaces that don't expose favoriting (e.g. the
   * settings auxiliary-model pickers).
   */
  favoriteModels?: string[];
  onFavoriteToggle?: (modelKey: string) => void;
  /** Render a Recommended section for models flagged `recommended`. */
  showRecommended?: boolean;
  /** Optional leading non-model option (e.g. "Same as agent model"). */
  defaultOption?: ModelPickerDefaultOption;

  placeholder?: string;
  /**
   * Trigger style:
   *  - `"chat"`: compact inline pill (used in the chat composer).
   *  - `"settings"`: full-width bordered button (used in settings).
   */
  trigger?: "chat" | "settings";
  /** Tooltip + keyboard hint shown on the chat trigger. */
  triggerTooltip?: ReactNode;

  /** Optional extra UI rendered above each model row's tooltip card. */
  renderModelInfo?: (model: ModelOption) => ReactNode;
  /** Optional footer rendered below the list (e.g. Configure button). */
  footer?: ReactNode;
  /** Optional extra block under the footer (e.g. thinking toggle). */
  footerExtra?: ReactNode;

  /** Controlled open state (e.g. driven by a keyboard shortcut). */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;

  disabled?: boolean;
}

/**
 * Build the lowercased searchable text for a model: display name + the
 * compound `provider:modelId` (so provider id and raw model id are
 * searchable) + the human provider label.
 *
 * Exported for unit testing.
 */
export function buildModelHaystack(
  name: string,
  compoundId: string,
  providerLabel: string,
): string {
  return `${name} ${compoundId} ${providerLabel}`.toLowerCase();
}

/**
 * Token-AND substring match: every whitespace-separated term in `query`
 * must appear somewhere in `haystack`. Order-independent and
 * partial-token friendly, so "flash 3.5" matches "Gemini 3.5 Flash".
 * An empty/whitespace query matches everything.
 *
 * Exported for unit testing.
 */
export function matchesModelQuery(haystack: string, query: string): boolean {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return true;
  return terms.every((t) => haystack.includes(t));
}

function resolveLabel(
  providerModels: ProviderModels[],
  value: string | undefined,
  defaultOption: ModelPickerDefaultOption | undefined,
  placeholder: string,
): string {
  if (!value) return placeholder;
  if (defaultOption && value === defaultOption.value)
    return defaultOption.label;
  const [providerId, ...modelIdParts] = value.split(":");
  const actualModelId =
    modelIdParts.length > 0 ? modelIdParts.join(":") : value;
  for (const group of providerModels) {
    if (modelIdParts.length > 0 && group.provider !== providerId) continue;
    const found = group.models.find((m) => m.id === actualModelId);
    if (found) return found.name;
  }
  return actualModelId;
}

/**
 * Searchable, provider-grouped model picker shared by the chat composer
 * and the settings auxiliary-model selectors (tidy / compaction /
 * completion-check).
 *
 * The chat composer passes `favoriteModels`/`onFavoriteToggle` +
 * `showRecommended` + a thinking-toggle `footerExtra`; the settings
 * surfaces pass a `defaultOption` ("Same as agent model") and omit
 * favoriting. Both draw from the same `providerModels` list — the set of
 * selectable models from *configured* providers — so settings no longer
 * shows only favorited models.
 */
export function ModelPicker({
  providerModels,
  value,
  onValueChange,
  favoriteModels,
  onFavoriteToggle,
  showRecommended = false,
  defaultOption,
  placeholder = "Select a model…",
  trigger = "settings",
  triggerTooltip,
  renderModelInfo,
  footer,
  footerExtra,
  open: controlledOpen,
  onOpenChange,
  disabled = false,
}: ModelPickerProps) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const open = controlledOpen ?? uncontrolledOpen;
  const setOpen = (next: boolean) => {
    if (onOpenChange) onOpenChange(next);
    else setUncontrolledOpen(next);
  };
  const [highlightedModelId, setHighlightedModelId] = useState<string | null>(
    null,
  );
  const [searchQuery, setSearchQuery] = useState("");

  const favorites = favoriteModels ?? [];

  const allModelItems = useMemo(() => {
    const items = providerModels.flatMap((g) =>
      g.models.map((m) => `${g.provider}:${m.id}`),
    );
    if (defaultOption) return [defaultOption.value, ...items];
    return items;
  }, [providerModels, defaultOption]);

  const modelIdToName = useMemo(() => {
    const map = new Map<string, string>();
    if (defaultOption) map.set(defaultOption.value, defaultOption.label);
    for (const group of providerModels) {
      for (const m of group.models) {
        map.set(`${group.provider}:${m.id}`, m.name);
      }
    }
    return map;
  }, [providerModels, defaultOption]);

  const modelIdToEnabled = useMemo(() => {
    const map = new Map<string, boolean>();
    if (defaultOption) map.set(defaultOption.value, true);
    for (const group of providerModels) {
      for (const m of group.models) {
        map.set(`${group.provider}:${m.id}`, group.enabled);
      }
    }
    return map;
  }, [providerModels, defaultOption]);

  // Precomputed searchable text per compound id. Used by base-ui's
  // internal `filter` (below) so its highlight/keyboard-nav set agrees
  // exactly with what the manual `sections` filter renders.
  const modelIdToHaystack = useMemo(() => {
    const map = new Map<string, string>();
    if (defaultOption) {
      map.set(
        defaultOption.value,
        buildModelHaystack(defaultOption.label, defaultOption.value, ""),
      );
    }
    for (const group of providerModels) {
      for (const m of group.models) {
        const compoundId = `${group.provider}:${m.id}`;
        map.set(compoundId, buildModelHaystack(m.name, compoundId, group.label));
      }
    }
    return map;
  }, [providerModels, defaultOption]);


  const sections = useMemo(() => {
    const q = searchQuery.trim();
    const filterModels = (
      models: ModelOption[],
      providerId: string,
      groupLabel: string,
    ) => {
      if (!q) return models;
      return models.filter((m) =>
        matchesModelQuery(
          buildModelHaystack(m.name, `${providerId}:${m.id}`, groupLabel),
          q,
        ),
      );
    };

    type Item = ModelOption & {
      providerId: string;
      providerLabel: string;
      enabled: boolean;
    };
    const favoriteItems: Item[] = [];
    const recommendedItems: Item[] = [];

    for (const group of providerModels) {
      const models = filterModels(group.models, group.provider, group.label);
      for (const m of models) {
        const item: Item = {
          ...m,
          providerId: group.provider,
          providerLabel: group.label,
          enabled: group.enabled,
        };
        if (favorites.includes(`${group.provider}:${m.id}`)) {
          favoriteItems.push(item);
        } else if (showRecommended && m.recommended) {
          recommendedItems.push(item);
        }
      }
    }

    const providerGroups = providerModels
      .map((group) => ({
        ...group,
        models: filterModels(group.models, group.provider, group.label),
      }))
      .filter((group) => group.models.length > 0);

    return {
      favorites: favoriteItems,
      recommended: recommendedItems,
      providers: providerGroups,
    };
  }, [providerModels, searchQuery, favorites, showRecommended]);

  const label = resolveLabel(providerModels, value, defaultOption, placeholder);

  const triggerButton =
    trigger === "chat" ? (
      <ComboboxTrigger
        disabled={disabled}
        className="flex items-center gap-0.5 rounded-md px-1.5 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
      >
        <span className="max-w-35 truncate">{label}</span>
      </ComboboxTrigger>
    ) : (
      <ComboboxTrigger
        disabled={disabled}
        className="flex h-8 w-fit items-center justify-between gap-1.5 rounded-lg border border-input bg-transparent py-2 pr-2 pl-2.5 text-sm whitespace-nowrap transition-colors outline-none select-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 data-placeholder:text-muted-foreground dark:bg-input/30 dark:hover:bg-input/50"
      >
        <span className={value ? "truncate" : "truncate text-muted-foreground"}>
          {label}
        </span>
      </ComboboxTrigger>
    );

  const renderRow = (item: {
    id: string;
    name: string;
    providerId: string;
    enabled: boolean;
    model: ModelOption;
    starState: "filled" | "outline" | "hover";
  }) => {
    const compoundId = `${item.providerId}:${item.id}`;
    const row = (
      <ComboboxItem
        value={compoundId}
        disabled={!item.enabled}
        onPointerMove={() => setHighlightedModelId(compoundId)}
        onFocus={() => setHighlightedModelId(compoundId)}
      >
        <RegistryIcon
          id={item.providerId}
          className={
            item.starState === "filled"
              ? "size-1.5 mr-1.5 shrink-0"
              : "size-2.5 mr-1.5 shrink-0 opacity-60 grayscale"
          }
        />
        <span className="flex-1 truncate">{item.name}</span>
        {!item.enabled && (
          <span className="mr-2 text-[10px] text-muted-foreground">
            Not configured
          </span>
        )}
        {onFavoriteToggle && (
          <button
            type="button"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              onFavoriteToggle(compoundId);
            }}
            className={
              item.starState === "filled"
                ? "order-last ml-2 text-primary transition-transform hover:scale-110"
                : item.starState === "outline"
                  ? "order-last ml-2 text-muted-foreground transition-colors hover:text-primary"
                  : "order-last ml-2 text-transparent transition-colors group-hover/command-item:text-muted-foreground hover:text-primary!"
            }
          >
            <StarGlyph filled={item.starState === "filled"} />
          </button>
        )}
      </ComboboxItem>
    );
    if (!renderModelInfo) {
      return <span key={compoundId}>{row}</span>;
    }
    return (
      <Tooltip key={compoundId} open={highlightedModelId === compoundId}>
        <TooltipTrigger asChild>{row}</TooltipTrigger>
        <TooltipContent
          side="right"
          sideOffset={12}
          hideArrow
          className="w-auto max-w-none border border-border bg-popover p-3 text-popover-foreground shadow-lg"
        >
          {renderModelInfo(item.model)}
        </TooltipContent>
      </Tooltip>
    );
  };

  const empty =
    sections.favorites.length === 0 &&
    sections.recommended.length === 0 &&
    sections.providers.length === 0;

  return (
    <Combobox
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) {
          setHighlightedModelId(null);
          setSearchQuery("");
        }
      }}
      onInputValueChange={(v) => setSearchQuery(v)}
      value={value ?? ""}
      onValueChange={(val) => {
        if (!val) return;
        if (modelIdToEnabled.get(val) === false) return;
        onValueChange(val);
        setOpen(false);
      }}
      items={allModelItems}
      itemToStringLabel={(id) => modelIdToName.get(id) ?? id}
      filter={(itemValue, query) =>
        matchesModelQuery(
          modelIdToHaystack.get(itemValue) ??
            buildModelHaystack(
              modelIdToName.get(itemValue) ?? itemValue,
              itemValue,
              "",
            ),
          query,
        )
      }
      autoHighlight
    >
      {triggerTooltip ? (
        <Tooltip>
          <TooltipTrigger asChild>{triggerButton}</TooltipTrigger>
          <TooltipContent>{triggerTooltip}</TooltipContent>
        </Tooltip>
      ) : (
        triggerButton
      )}
      <ComboboxContent
        side={trigger === "chat" ? "top" : "bottom"}
        sideOffset={4}
        className="w-[320px] border border-border shadow-lg"
      >
          <ComboboxInput placeholder="Select a model..." showTrigger={false} />
          <ComboboxList className="max-h-75 overflow-y-auto">
            {empty && (
              <div className="flex w-full justify-center py-2 text-center text-sm text-muted-foreground">
                No models found
              </div>
            )}

            {defaultOption && !searchQuery.trim() && (
              <ComboboxGroup>
                <ComboboxItem value={defaultOption.value}>
                  <span className="flex-1 truncate">{defaultOption.label}</span>
                </ComboboxItem>
              </ComboboxGroup>
            )}

            {sections.favorites.length > 0 && (
              <ComboboxGroup>
                <ComboboxLabel className="sticky top-0 z-10 bg-popover/95 backdrop-blur-sm">
                  Favorites
                </ComboboxLabel>
                {sections.favorites.map((m) =>
                  renderRow({
                    id: m.id,
                    name: m.name,
                    providerId: m.providerId,
                    enabled: m.enabled,
                    model: m,
                    starState: "filled",
                  }),
                )}
              </ComboboxGroup>
            )}

            {sections.recommended.length > 0 && (
              <ComboboxGroup>
                <ComboboxLabel className="sticky top-0 z-10 bg-popover/95 backdrop-blur-sm">
                  Recommended
                </ComboboxLabel>
                {sections.recommended.map((m) =>
                  renderRow({
                    id: m.id,
                    name: m.name,
                    providerId: m.providerId,
                    enabled: m.enabled,
                    model: m,
                    starState: "outline",
                  }),
                )}
              </ComboboxGroup>
            )}

            {sections.providers.map((group) => (
              <ComboboxGroup key={group.provider}>
                <ComboboxLabel className="sticky top-0 z-10 bg-popover/95 backdrop-blur-sm">
                  {group.label}
                </ComboboxLabel>
                {group.models.map((model) =>
                  renderRow({
                    id: model.id,
                    name: model.name,
                    providerId: group.provider,
                    enabled: group.enabled,
                    model,
                    starState: favorites.includes(
                      `${group.provider}:${model.id}`,
                    )
                      ? "filled"
                      : "hover",
                  }),
                )}
              </ComboboxGroup>
            ))}
          </ComboboxList>

          {footer}
          {footerExtra}
        </ComboboxContent>
    </Combobox>
  );
}

function StarGlyph({ filled }: { filled: boolean }) {
  return <Star className={`size-3.5 ${filled ? "fill-current" : ""}`} />;
}

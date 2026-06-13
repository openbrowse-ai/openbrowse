import { useState, useEffect, useMemo } from "react";
import { ScrollText, Trash2, Bot } from "lucide-react";
import { OPFS } from "@/lib/vfs/opfs";
import { vfsEvents } from "@/lib/vfs/events";
import { chatDb } from "@/lib/chat-db";
import { UPLOADS_DIR } from "@/lib/uploads-dir";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { RegistryIcon } from "@/components/ui/registry-icon";
import { getConnector } from "@openbrowse/connectors";
import { requestCloseAgentTabs } from "./request-close-agent-tabs";
import { CoworkCard } from "./cowork-card";
import { ContextEmptyArt } from "./empty-art";
import { FileTypeIcon } from "./file-type-icon";

interface DerivedConnector {
  id: string;
  name: string;
}

interface ContextTab {
  id: number;
  title: string;
  favicon: string;
  /**
   * Conversation that owns this tab in `tab-scoping` (whose `ownedTabIds`
   * the tab id lives in). For tabs created by the parent agent this is
   * the parent's id; for tabs created by a subagent this is the child
   * conversation's id. Cleanup must close tabs against their owner so
   * the owner's `ownedTabIds` gets cleared (see `closeOwnedTabs`).
   */
  owningConversationId: string;
  /**
   * Set when this tab is owned by a subagent (i.e. owningConversationId
   * != parent conversationId). Used to render an indicator badge in the
   * Context card's Tabs section.
   */
  subagent?: { label: string };
}

export function ContextCard({
  conversationId,
  onSelectFile,
  collapsible = true,
  showHeader = true,
}: {
  conversationId: string;
  onSelectFile: (file: string | null) => void;
  collapsible?: boolean;
  showHeader?: boolean;
}) {
  const uploadsRoot = useMemo(
    () => `conversations/${conversationId}/workspace/${UPLOADS_DIR}`,
    [conversationId],
  );

  const [tabs, setTabs] = useState<ContextTab[]>([]);
  const [uploads, setUploads] = useState<string[]>([]);
  const [connectors, setConnectors] = useState<DerivedConnector[]>([]);
  const [skills, setSkills] = useState<string[]>([]);

  // Poll: tabs (from ownedTabIds) + connectors/skills (from message parts).
  useEffect(() => {
    let isMounted = true;

    async function refresh() {
      const conv = await chatDb.getConversation(conversationId);
      if (!isMounted) return;

      // Tabs — collect parent-owned tabs first, then any tabs owned by
      // subagent children (peer subagents bind their tabs to the *child*
      // conversation row in tab-scoping; incognito subagents normally
      // auto-close their ephemeral window, but if any child tabs are
      // still alive we surface them too). Each id is hydrated via
      // chrome.tabs.get; closed tabs (rejected promises) drop out.
      const children = await chatDb.listChildren(conversationId);
      if (!isMounted) return;

      type OwnedRef = {
        tabId: number;
        owningConversationId: string;
        subagent?: { label: string };
      };
      const ownedRefs: OwnedRef[] = [];
      for (const id of conv?.ownedTabIds ?? []) {
        ownedRefs.push({ tabId: id, owningConversationId: conversationId });
      }
      for (const child of children) {
        const label =
          child.subagentTraceTitle ??
          child.subagentSlug ??
          "Subagent";
        for (const id of child.ownedTabIds ?? []) {
          ownedRefs.push({
            tabId: id,
            owningConversationId: child.id,
            subagent: { label },
          });
        }
      }

      // `Promise.allSettled` preserves input order, so the resulting rows
      // keep ownedRefs order (parent tabs first, then subagent tabs).
      const results = await Promise.allSettled(
        ownedRefs.map((r) => chrome.tabs.get(r.tabId)),
      );
      if (!isMounted) return;
      const hydrated: ContextTab[] = [];
      results.forEach((res, i) => {
        if (res.status === "fulfilled") {
          const tab = res.value;
          const ref = ownedRefs[i];
          hydrated.push({
            id: ref.tabId,
            title: tab.title || tab.url || "Untitled tab",
            favicon: tab.favIconUrl ?? "",
            owningConversationId: ref.owningConversationId,
            subagent: ref.subagent,
          });
        }
      });
      if (isMounted) setTabs(hydrated);

      if (!isMounted) return;
      // Connectors + skills are recorded live onto the conversation row at
      // step-finish time (see recordToolUsageForStep in agent-transport), so
      // we read them directly from `conv` rather than scanning message parts.
      const connectorList: DerivedConnector[] = (conv?.usedConnectorIds ?? [])
        .map((id) => {
          const c = getConnector(id);
          return c ? { id: c.id, name: c.name } : null;
        })
        .filter((c): c is DerivedConnector => c !== null);
      setConnectors(connectorList);
      setSkills(conv?.loadedSkillNames ?? []);
    }

    refresh();
    const interval = setInterval(refresh, 1000);
    return () => {
      isMounted = false;
      clearInterval(interval);
    };
  }, [conversationId]);

  // Uploads: OPFS walk over `.uploads/`, refreshed on vfs:change.
  useEffect(() => {
    let mounted = true;

    async function fetchUploads() {
      const names: string[] = [];
      try {
        for await (const path of OPFS.walk(uploadsRoot)) {
          const rel = path.startsWith(uploadsRoot + "/")
            ? path.slice(uploadsRoot.length + 1)
            : path;
          if (rel) names.push(rel);
        }
      } catch {
        // No uploads dir yet.
      }
      if (mounted) setUploads(names.sort());
    }

    fetchUploads();
    const onVfsChange = (e: Event) => {
      const { path } = (e as CustomEvent).detail ?? {};
      if (typeof path === "string" && path.startsWith(uploadsRoot)) {
        fetchUploads();
      }
    };
    vfsEvents.addEventListener("vfs:change", onVfsChange);
    return () => {
      mounted = false;
      vfsEvents.removeEventListener("vfs:change", onVfsChange);
    };
  }, [uploadsRoot]);

  const isEmpty =
    tabs.length === 0 &&
    uploads.length === 0 &&
    connectors.length === 0 &&
    skills.length === 0;

  const [isCleaningTabs, setIsCleaningTabs] = useState(false);

  const handleCleanupTabs = async () => {
    if (isCleaningTabs || tabs.length === 0) return;
    setIsCleaningTabs(true);
    try {
      // Tabs owned by a subagent live in the *child* conversation's
      // `ownedTabIds`; closing them against the parent id wouldn't
      // clear the child row. Group by owning conversation id so each
      // owner's list is cleaned up correctly. `closeOwnedTabs`
      // (background) closes the tabs, clears ownership, and broadcasts
      // AGENT_TABS_CLOSED → Undo toast (handled in useAgentChat). The
      // poll loop refreshes `tabs` to [] on the next tick.
      const byOwner = new Map<string, number[]>();
      for (const t of tabs) {
        const ids = byOwner.get(t.owningConversationId) ?? [];
        ids.push(t.id);
        byOwner.set(t.owningConversationId, ids);
      }
      await Promise.all(
        Array.from(byOwner.entries()).map(([ownerId, ids]) =>
          requestCloseAgentTabs(ownerId, ids),
        ),
      );
    } finally {
      setIsCleaningTabs(false);
    }
  };

  return (
    <CoworkCard title="Context" collapsible={collapsible} showHeader={showHeader}>
      {isEmpty ? (
        <div className="flex flex-col items-start gap-3 px-3.5 py-3 text-left">
          <ContextEmptyArt />
          <p className="text-[13px] leading-snug text-muted-foreground">
            Track tools and referenced files used in this task.
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-2 px-1.5 pb-1">
          {tabs.length > 0 && (
            <ContextSection
              label="Tabs"
              action={
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      onClick={handleCleanupTabs}
                      disabled={isCleaningTabs}
                      className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-background hover:text-foreground disabled:opacity-50 disabled:pointer-events-none"
                      aria-label={`Clean up ${tabs.length} ${tabs.length === 1 ? "tab" : "tabs"}`}
                    >
                      <Trash2 className="size-3.5" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="left">
                    Close {tabs.length} {tabs.length === 1 ? "tab" : "tabs"}
                  </TooltipContent>
                </Tooltip>
              }
            >
              {tabs.map((tab) => (
                <ContextTabRow key={tab.id} tab={tab} />
              ))}
            </ContextSection>
          )}
          {uploads.length > 0 && (
            <ContextSection label="Uploads">
              {uploads.map((name) => (
                <ContextRow
                  key={name}
                  icon={<FileTypeIcon filename={name} />}
                  label={name}
                  onClick={() => onSelectFile(`${UPLOADS_DIR}/${name}`)}
                />
              ))}
            </ContextSection>
          )}
          {connectors.length > 0 && (
            <ContextSection label="Connectors">
              {connectors.map((c) => (
                <ContextRow
                  key={c.id}
                  icon={<RegistryIcon id={c.id} className="size-3.5" />}
                  label={c.name}
                />
              ))}
            </ContextSection>
          )}
          {skills.length > 0 && (
            <ContextSection label="Skills">
              {skills.map((name) => (
                <ContextRow
                  key={name}
                  icon={<ScrollText className="size-3.5" />}
                  label={name}
                />
              ))}
            </ContextSection>
          )}
        </div>
      )}
    </CoworkCard>
  );
}

function ContextSection({
  label,
  action,
  children,
}: {
  label: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="flex items-center justify-between px-2 pb-1 pt-1.5">
        <span className="text-xs text-muted-foreground">{label}</span>
        {action}
      </div>
      <ul className="space-y-0.5">{children}</ul>
    </div>
  );
}

/** Generic display/clickable row: icon chip + truncating label. */
function ContextRow({
  icon,
  label,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  onClick?: () => void;
}) {
  const inner = (
    <>
      <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
        {icon}
      </span>
      <span className="truncate">{label}</span>
    </>
  );
  if (onClick) {
    return (
      <li>
        <button
          type="button"
          onClick={onClick}
          className="flex w-full items-center gap-2.5 rounded-md px-1.5 py-1.5 text-left text-sm hover:bg-muted/60 min-w-0"
        >
          {inner}
        </button>
      </li>
    );
  }
  return (
    <li>
      <div className="flex items-center gap-2.5 rounded-md px-1.5 py-1.5 text-sm min-w-0">
        {inner}
      </div>
    </li>
  );
}

function ContextTabRow({ tab }: { tab: ContextTab }) {
  const focusTab = () => {
    void (async () => {
      try {
        await chrome.tabs.update(tab.id, { active: true });
        const t = await chrome.tabs.get(tab.id);
        if (typeof t.windowId === "number") {
          await chrome.windows.update(t.windowId, { focused: true });
        }
      } catch {
        // Tab gone; next poll will drop it.
      }
    })();
  };
  return (
    <li>
      <button
        type="button"
        onClick={focusTab}
        className="flex w-full items-center gap-2.5 rounded-md px-1.5 py-1.5 text-left text-sm hover:bg-muted/60 min-w-0"
      >
        <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
          {tab.favicon ? (
            <img src={tab.favicon} alt="" className="size-3.5 rounded-sm" />
          ) : (
            <span className="size-3.5 rounded-sm bg-muted-foreground/30" />
          )}
        </span>
        <span className="truncate flex-1">{tab.title}</span>
        {tab.subagent && (
          <Tooltip>
            <TooltipTrigger asChild>
              <span
                className="flex size-5 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground"
                aria-label={`Used by subagent: ${tab.subagent.label}`}
              >
                <Bot className="size-3" />
              </span>
            </TooltipTrigger>
            <TooltipContent side="left">
              Used by subagent: {tab.subagent.label}
            </TooltipContent>
          </Tooltip>
        )}
      </button>
    </li>
  );
}

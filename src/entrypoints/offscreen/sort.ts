import type { AIProvider } from "@/lib/types";
import { generateText, Output } from "ai";
import { z } from "zod";
import { getModel, type CloudConfig } from "./ai";

// --- Schemas ---

const tidyResultSchema = z.object({
  summary: z.string(),
  tabs: z.array(
    z.object({
      id: z.string(),
      tidiedTitle: z.string(),
      archive: z.boolean().optional(),
    }),
  ),
});

const groupResultSchema = z.object({
  sections: z.array(
    z.object({
      name: z.string(),
      domains: z.array(z.string()),
    }),
  ),
});

const combinedResultSchema = z.object({
  sections: z.array(
    z.object({
      name: z.string(),
      tabs: z.array(
        z.object({
          id: z.string(),
          tidiedTitle: z.string(),
          archive: z.boolean().optional(),
        }),
      ),
    }),
  ),
});

// --- Types ---

interface TabInput {
  id: string;
  url: string;
  title: string;
  context?: {
    h1?: string;
    description?: string;
    snippet?: string;
    type?: string;
    siteName?: string;
  };
}

type TidiedTab = { id: string; tidiedTitle: string; archive?: boolean };

type ArchiveAggressiveness = "low" | "medium" | "high";

type SortOutput = {
  sections: { name: string; tabs: TidiedTab[] }[];
  tabs: TidiedTab[];
  archivedTabIds: string[];
};

function getArchiveInstructions(level: ArchiveAggressiveness): string {
  switch (level) {
    case "low":
      return `Archive: set archive=true ONLY for tabs that are clearly junk — error pages (404, 500, DNS errors), blank/empty pages, or exact duplicate URLs within the same batch. Do NOT archive tabs just because they seem old or low-value.`;
    case "medium":
      return `Archive: set archive=true for tabs that are low-value or redundant. This includes: error pages (404, 500, DNS errors), blank/empty pages, exact duplicate URLs, near-duplicate pages (same content, different URL params), pages that appear to be transient (search results, login redirects, OAuth callbacks, one-time confirmation pages), and tabs that are clearly outdated or superseded by another tab in the batch.`;
    case "high":
      return `Archive: set archive=true for any tab that is unlikely to be needed again. This includes: error pages, blank pages, duplicates and near-duplicates, transient pages (search results, login flows, OAuth callbacks, confirmations), outdated content, generic homepages with no specific context, tabs that appear to be "drive-by" visits (brief lookups, quick references already consumed), and any tab whose content is easily re-findable via search. When in doubt, archive it — the user prefers a clean workspace over keeping stale tabs around.`;
  }
}

// --- Progress reporting ---

let progressPort: chrome.runtime.Port | null = null;

function reportProgress(phase: number, current: number, total: number) {
  try {
    if (!progressPort) {
      progressPort = chrome.runtime.connect({ name: "tidy-progress" });
      progressPort.onDisconnect.addListener(() => {
        progressPort = null;
      });
    }
    progressPort.postMessage({ phase, current, total });
  } catch (e) {
    log("reportProgress failed:", e);
    progressPort = null;
  }
}

// --- Token budget ---

// Local models (browser-ai, web-llm) have tiny context windows
const LOCAL_CONTEXT_WINDOW = 4096;
const LOCAL_OUTPUT_BUDGET = 1200;

// Cloud models have massive context windows (128K+)
const CLOUD_CONTEXT_WINDOW = 128000;
const CLOUD_OUTPUT_BUDGET = 8000;

const PROMPT_TEMPLATE_CHARS = 400;
const CHARS_PER_TOKEN = 3;

function getMaxTabListChars(isCloud: boolean): number {
  const contextWindow = isCloud ? CLOUD_CONTEXT_WINDOW : LOCAL_CONTEXT_WINDOW;
  const outputBudget = isCloud ? CLOUD_OUTPUT_BUDGET : LOCAL_OUTPUT_BUDGET;
  return (
    (contextWindow - outputBudget) * CHARS_PER_TOKEN - PROMPT_TEMPLATE_CHARS
  );
}

// #region DEBUG
const log = (...args: any[]) => console.log("[OpenBrowse sort]", ...args);
// #endregion DEBUG

// --- Helpers ---

function getDomain(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

function formatTab(t: TabInput): string {
  let line = `- id="${t.id}" title="${t.title}" url=${t.url}`;
  if (t.context) {
    const parts: string[] = [];
    if (t.context.siteName) parts.push(`site="${t.context.siteName}"`);
    if (t.context.h1 && t.context.h1 !== t.title)
      parts.push(`h1="${t.context.h1}"`);
    if (t.context.description) parts.push(`desc="${t.context.description}"`);
    else if (t.context.snippet)
      parts.push(`snippet="${t.context.snippet.slice(0, 150)}"`);
    if (parts.length > 0) line += ` ${parts.join(" ")}`;
  }
  return line;
}

function groupByDomain(tabs: TabInput[]): Map<string, TabInput[]> {
  const groups = new Map<string, TabInput[]>();
  for (const tab of tabs) {
    const domain = getDomain(tab.url);
    const group = groups.get(domain) || [];
    group.push(tab);
    groups.set(domain, group);
  }
  return groups;
}

function batchByCharLimit(tabs: TabInput[], maxChars: number): TabInput[][] {
  const batches: TabInput[][] = [];
  let current: TabInput[] = [];
  let currentChars = 0;

  for (const tab of tabs) {
    const lineChars = formatTab(tab).length + 1;
    if (current.length > 0 && currentChars + lineChars > maxChars) {
      batches.push(current);
      current = [];
      currentChars = 0;
    }
    current.push(tab);
    currentChars += lineChars;
  }

  if (current.length > 0) batches.push(current);
  return batches;
}

// --- Phase 1: Tidy titles per domain group ---

interface TidyBatchResult {
  summary: string;
  tabs: TidiedTab[];
}

async function tidyBatch(
  tabs: TabInput[],
  model: any,
  batchLabel: string,
  archiveLevel: ArchiveAggressiveness = "medium",
): Promise<TidyBatchResult> {
  const tabList = tabs.map(formatTab).join("\n");
  // #region DEBUG
  log(`[P1] ${batchLabel}: ${tabs.length} tabs, ${tabList.length} chars`);
  // #endregion DEBUG

  // #region DEBUG
  log(`[P1] ${batchLabel}: calling generateText...`);
  // #endregion DEBUG
  const { output } = await generateText({
    model,
    output: Output.object({ schema: tidyResultSchema }),
    providerOptions: { "web-llm": { extra_body: { enable_thinking: false } } },
    prompt: `Generate a short clean display title for each browser tab, and a one-line summary (max 15 words) describing what this group of tabs is about collectively. Use the page context to understand what each tab is actually about.

Tidied titles: max 40 chars, concise but descriptive — capture the specific page content, not just the site name.
Summary: describe the common theme/topic across these tabs in one short phrase.
${getArchiveInstructions(archiveLevel)}

Tabs:
${tabList}

Return a summary and each tab's id with its tidied title and archive flag.`,
  });

  // #region DEBUG
  log(
    `[P1] ${batchLabel}: done. summary="${output?.summary ?? "(none)"}", ${output?.tabs?.length ?? 0} tidied`,
  );
  // #endregion DEBUG

  return {
    summary: output?.summary ?? "",
    tabs:
      output?.tabs ??
      tabs.map((t) => ({ id: t.id, tidiedTitle: t.title.slice(0, 40) })),
  };
}

interface DomainResult {
  tabs: TidiedTab[];
  summary: string;
}

async function tidyDomainGroup(
  domain: string,
  tabs: TabInput[],
  model: any,
  isCloud = false,
  archiveLevel: ArchiveAggressiveness = "medium",
): Promise<DomainResult> {
  const batches = batchByCharLimit(tabs, getMaxTabListChars(isCloud));
  // #region DEBUG
  log(
    `[P1] domain="${domain}": ${tabs.length} tabs, ${batches.length} batch(es)`,
  );
  // #endregion DEBUG
  const allTabs: TidiedTab[] = [];
  const summaries: string[] = [];
  for (let i = 0; i < batches.length; i++) {
    const result = await tidyBatch(
      batches[i],
      model,
      `${domain} batch ${i + 1}/${batches.length}`,
      archiveLevel,
    );
    allTabs.push(...result.tabs);
    if (result.summary) summaries.push(result.summary);
  }
  return { tabs: allTabs, summary: summaries[0] || "" };
}

// --- Phase 2: Assign domains to sections ---

async function assignSections(
  domainSummaries: { domain: string; count: number; summary: string }[],
  model: any,
): Promise<{ name: string; domains: string[] }[]> {
  const summaryList = domainSummaries
    .map(
      (d) => `- ${d.domain} (${d.count} tabs): ${d.summary || "various pages"}`,
    )
    .join("\n");

  const summaryChars = summaryList.length;
  const isCloud = !!model?._isCloud;
  const maxChars = getMaxTabListChars(isCloud);
  // #region DEBUG
  log(
    `[P2] ${domainSummaries.length} domains, ${summaryChars} chars (max=${maxChars})`,
  );
  // #endregion DEBUG
  if (summaryChars > maxChars) {
    // #region DEBUG
    log(`[P2] summary too large, skipping grouping`);
    // #endregion DEBUG
    return [
      { name: "All Tabs", domains: domainSummaries.map((d) => d.domain) },
    ];
  }

  const { output } = await generateText({
    model,
    output: Output.object({ schema: groupResultSchema }),
    providerOptions: { "web-llm": { extra_body: { enable_thinking: false } } },
    prompt: `Group these website domains into 2-8 logical sections by topic. Every domain must appear in exactly one section.

Section names: Short (1-3 words), descriptive.

Domains:
${summaryList}

Return section names with their domain lists.`,
  });

  if (!output?.sections?.length) {
    // #region DEBUG
    log(`[P2] no sections returned, falling back to "All Tabs"`);
    // #endregion DEBUG
    return [
      { name: "All Tabs", domains: domainSummaries.map((d) => d.domain) },
    ];
  }

  // #region DEBUG
  log(
    `[P2] ${output.sections.length} sections:`,
    output.sections
      .map((s) => `${s.name} (${s.domains.length} domains)`)
      .join(", "),
  );
  // #endregion DEBUG
  return output.sections;
}

// --- Single-call cloud fast path ---

async function sortTabsSingleCall(
  tabs: TabInput[],
  model: any,
  archiveLevel: ArchiveAggressiveness = "medium",
): Promise<SortOutput> {
  const tabList = tabs.map(formatTab).join("\n");
  log(`[single-call] ${tabs.length} tabs, ${tabList.length} chars`);

  reportProgress(1, 0, 1);
  const { output } = await generateText({
    model,
    output: Output.object({ schema: combinedResultSchema }),
    prompt: `You are a tab organizer. Given a list of browser tabs, do ALL of the following in one pass:

1. **Tidy titles**: For each tab, generate a short clean display title (max 40 chars). Use the page context to understand what each tab is about. Be specific — capture the page content, not just the site name.
2. **Group into sections**: Organize tabs into 2-8 logical sections by topic. Section names should be short (1-3 words) and descriptive.
3. ${getArchiveInstructions(archiveLevel)}

Every tab must appear in exactly one section.

Tabs:
${tabList}

Return sections, each with a name and its tabs (id, tidiedTitle, archive flag).`,
  });
  reportProgress(1, 1, 1);

  if (!output?.sections?.length) {
    log(`[single-call] no sections returned, falling back`);
    return { sections: [], tabs: [], archivedTabIds: [] };
  }

  const archivedTabIds: string[] = [];
  const sections: SortOutput["sections"] = [];

  for (const section of output.sections) {
    const kept: TidiedTab[] = [];
    for (const tab of section.tabs) {
      if (tab.archive) {
        archivedTabIds.push(tab.id);
      } else {
        kept.push({ id: tab.id, tidiedTitle: tab.tidiedTitle });
      }
    }
    if (kept.length > 0) {
      sections.push({ name: section.name, tabs: kept });
    }
  }

  log(`[single-call] done: ${sections.length} sections, ${archivedTabIds.length} archived`);
  return { sections, tabs: [], archivedTabIds };
}

// --- Main ---

let sortInProgress = false;

export async function sortTabs(
  tabs: TabInput[],
  provider?: AIProvider,
  modelId?: string,
  cloudConfig?: import("./ai").CloudConfig,
  archiveLevel?: ArchiveAggressiveness,
): Promise<SortOutput> {
  if (tabs.length === 0) return { sections: [], tabs: [], archivedTabIds: [] };

  if (sortInProgress) {
    log("sortTabs already in progress, ignoring duplicate call");
    return { sections: [], tabs: [], archivedTabIds: [] };
  }
  sortInProgress = true;

  try {
    return await sortTabsInner(tabs, provider, modelId, cloudConfig, archiveLevel);
  } finally {
    sortInProgress = false;
    reportProgress(-1, 0, 0);
  }
}

async function sortTabsInner(
  tabs: TabInput[],
  provider?: AIProvider,
  modelId?: string,
  cloudConfig?: CloudConfig,
  archiveLevel: ArchiveAggressiveness = "medium",
): Promise<SortOutput> {
  const isCloud = provider === "cloud";
  const maxChars = getMaxTabListChars(isCloud);
  // Max parallel cloud API calls to avoid rate limits
  const CLOUD_CONCURRENCY = 5;

  // #region DEBUG
  log(
    `sortTabs called: ${tabs.length} tabs, provider=${provider}, model=${modelId}, isCloud=${isCloud}, maxChars=${maxChars}`,
  );
  // #endregion DEBUG

  // #region DEBUG
  log(`getting model...`);
  // #endregion DEBUG
  reportProgress(0, 0, 0);
  const model = await getModel(provider, modelId, cloudConfig);
  // #region DEBUG
  log(`model ready`);
  // #endregion DEBUG

  // Cloud fast path: single API call when all tabs fit in context
  if (isCloud) {
    const tabListChars = tabs.reduce((sum, t) => sum + formatTab(t).length + 1, 0);
    if (tabListChars <= maxChars) {
      log(`[cloud fast path] ${tabListChars} chars fits in ${maxChars}, using single call`);
      return sortTabsSingleCall(tabs, model, archiveLevel);
    }
    log(`[cloud fast path] ${tabListChars} chars exceeds ${maxChars}, falling back to batched`);
  }

  const domainGroups = groupByDomain(tabs);

  // #region DEBUG
  log(
    `${domainGroups.size} domains:`,
    Array.from(domainGroups.entries())
      .map(([d, t]) => `${d}(${t.length})`)
      .join(", "),
  );
  // #endregion DEBUG

  // Phase 1: tidy titles per domain
  // For cloud: larger batches + parallel execution
  // For local: small batches + sequential (single GPU)
  const SMALL_DOMAIN_THRESHOLD = isCloud ? 5 : 2;
  const largeDomains: [string, TabInput[]][] = [];
  const smallDomainTabs: TabInput[] = [];
  const smallDomainMap = new Map<string, TabInput[]>();

  for (const [domain, domainTabs] of domainGroups) {
    if (domainTabs.length > SMALL_DOMAIN_THRESHOLD) {
      largeDomains.push([domain, domainTabs]);
    } else {
      smallDomainTabs.push(...domainTabs);
      smallDomainMap.set(domain, domainTabs);
    }
  }

  // #region DEBUG
  log(
    `[P1] ${largeDomains.length} large domains, ${smallDomainMap.size} small domains (${smallDomainTabs.length} tabs) to batch, isCloud=${isCloud}`,
  );
  // #endregion DEBUG

  const domainResults = new Map<string, DomainResult>();

  const totalCalls =
    largeDomains.length +
    (smallDomainTabs.length > 0
      ? batchByCharLimit(smallDomainTabs, maxChars).length
      : 0);
  let completedCalls = 0;

  if (isCloud) {
    // --- Cloud path: parallel processing ---

    // Process large domains in parallel (with concurrency limit)
    const largeDomainTasks = largeDomains.map(
      ([domain, domainTabs]) =>
        async () => {
          try {
            const result = await tidyDomainGroup(
              domain,
              domainTabs,
              model,
              true,
              archiveLevel,
            );
            domainResults.set(domain, result);
          } catch (err) {
            log(`[P1] FAILED domain="${domain}":`, err);
            domainResults.set(domain, {
              tabs: domainTabs.map((t) => ({
                id: t.id,
                tidiedTitle: t.title.slice(0, 40),
              })),
              summary: "",
            });
          }
          completedCalls++;
          reportProgress(1, completedCalls, totalCalls);
        },
    );

    // Process small domains in batches, also parallel
    const smallBatches =
      smallDomainTabs.length > 0
        ? batchByCharLimit(smallDomainTabs, maxChars)
        : [];
    const smallBatchTasks = smallBatches.map((batch, i) => async () => {
      try {
        const result = await tidyBatch(
          batch,
          model,
          `small-domains batch ${i + 1}/${smallBatches.length}`,
          archiveLevel,
        );
        const tidiedById = new Map(result.tabs.map((t) => [t.id, t]));
        for (const [domain, domainTabs] of smallDomainMap) {
          const domainTidied = domainTabs
            .map((t) => tidiedById.get(t.id))
            .filter((t): t is TidiedTab => t !== undefined);
          if (domainTidied.length > 0) {
            const existing = domainResults.get(domain);
            if (existing) {
              existing.tabs.push(...domainTidied);
            } else {
              domainResults.set(domain, {
                tabs: domainTidied,
                summary: result.summary,
              });
            }
          }
        }
      } catch (err) {
        log(`[P1] FAILED small-domains batch ${i + 1}:`, err);
        for (const tab of batch) {
          const domain = getDomain(tab.url);
          const existing = domainResults.get(domain);
          const fallback = { id: tab.id, tidiedTitle: tab.title.slice(0, 40) };
          if (existing) {
            existing.tabs.push(fallback);
          } else {
            domainResults.set(domain, { tabs: [fallback], summary: "" });
          }
        }
      }
      completedCalls++;
      reportProgress(1, completedCalls, totalCalls);
    });

    // Run all tasks with concurrency limit
    const allTasks = [...largeDomainTasks, ...smallBatchTasks];
    log(
      `[P1] cloud: ${allTasks.length} total tasks, concurrency=${CLOUD_CONCURRENCY}`,
    );
    for (let i = 0; i < allTasks.length; i += CLOUD_CONCURRENCY) {
      const chunk = allTasks.slice(i, i + CLOUD_CONCURRENCY);
      await Promise.all(chunk.map((task) => task()));
    }
  } else {
    // --- Local path: sequential processing (single GPU) ---

    // Process large domains individually
    for (const [domain, domainTabs] of largeDomains) {
      try {
        const result = await tidyDomainGroup(domain, domainTabs, model, false, archiveLevel);
        domainResults.set(domain, result);
      } catch (err) {
        // #region DEBUG
        log(`[P1] FAILED domain="${domain}":`, err);
        // #endregion DEBUG
        domainResults.set(domain, {
          tabs: domainTabs.map((t) => ({
            id: t.id,
            tidiedTitle: t.title.slice(0, 40),
          })),
          summary: "",
        });
      }
      completedCalls++;
      reportProgress(1, completedCalls, totalCalls);
    }

    // Process small domains in combined batches
    if (smallDomainTabs.length > 0) {
      const smallBatches = batchByCharLimit(smallDomainTabs, maxChars);
      // #region DEBUG
      log(
        `[P1] small domains: ${smallDomainTabs.length} tabs in ${smallBatches.length} batch(es)`,
      );
      // #endregion DEBUG
      for (let i = 0; i < smallBatches.length; i++) {
        try {
          const result = await tidyBatch(
            smallBatches[i],
            model,
            `small-domains batch ${i + 1}/${smallBatches.length}`,
            archiveLevel,
          );
          const tidiedById = new Map(result.tabs.map((t) => [t.id, t]));

          for (const [domain, domainTabs] of smallDomainMap) {
            const domainTidied = domainTabs
              .map((t) => tidiedById.get(t.id))
              .filter((t): t is TidiedTab => t !== undefined);
            if (domainTidied.length > 0) {
              const existing = domainResults.get(domain);
              if (existing) {
                existing.tabs.push(...domainTidied);
              } else {
                domainResults.set(domain, {
                  tabs: domainTidied,
                  summary: result.summary,
                });
              }
            }
          }
        } catch (err) {
          // #region DEBUG
          log(`[P1] FAILED small-domains batch ${i + 1}:`, err);
          // #endregion DEBUG
          for (const tab of smallBatches[i]) {
            const domain = getDomain(tab.url);
            const existing = domainResults.get(domain);
            const fallback = {
              id: tab.id,
              tidiedTitle: tab.title.slice(0, 40),
            };
            if (existing) {
              existing.tabs.push(fallback);
            } else {
              domainResults.set(domain, { tabs: [fallback], summary: "" });
            }
          }
        }
        completedCalls++;
        reportProgress(1, completedCalls, totalCalls);
      }
    }
  }

  // Collect archived tab IDs from all domain results
  const archivedTabIds: string[] = [];
  for (const result of domainResults.values()) {
    for (const tab of result.tabs) {
      if (tab.archive) archivedTabIds.push(tab.id);
    }
  }

  // Remove archived tabs from domain results so they don't appear in sections
  if (archivedTabIds.length > 0) {
    const archivedSet = new Set(archivedTabIds);
    for (const [domain, result] of domainResults) {
      result.tabs = result.tabs.filter((t) => !archivedSet.has(t.id));
    }
  }

  // If few domains, skip the grouping call
  if (domainGroups.size <= 3) {
    const sections = Array.from(domainGroups.entries()).map(([domain]) => ({
      name:
        domainResults.get(domain)?.summary ||
        domain.replace(/^www\./, "").split(".")[0],
      tabs: domainResults.get(domain)?.tabs || [],
    }));
    return {
      sections: sections.filter((s) => s.tabs.length > 0),
      tabs: [],
      archivedTabIds,
    };
  }

  // Phase 2: group domains into sections using summaries from phase 1
  const domainSummaries = Array.from(domainGroups.entries()).map(
    ([domain, domainTabs]) => ({
      domain,
      count: domainTabs.length,
      summary: domainResults.get(domain)?.summary || "",
    }),
  );

  reportProgress(2, 0, 1);
  const sectionAssignments = await assignSections(domainSummaries, model);
  reportProgress(2, 1, 1);

  // Build final output
  const sections: SortOutput["sections"] = [];
  const assignedDomains = new Set<string>();

  for (const assignment of sectionAssignments) {
    const sectionTabs: TidiedTab[] = [];
    for (const domain of assignment.domains) {
      const tidied = domainResults.get(domain)?.tabs;
      if (tidied) {
        sectionTabs.push(...tidied);
        assignedDomains.add(domain);
      }
    }
    if (sectionTabs.length > 0) {
      sections.push({ name: assignment.name, tabs: sectionTabs });
    }
  }

  // Catch any domains the LLM missed
  const unsectioned: TidiedTab[] = [];
  for (const [domain, result] of domainResults) {
    if (!assignedDomains.has(domain)) {
      unsectioned.push(...result.tabs);
    }
  }

  // #region DEBUG
  log(`done: ${sections.length} sections, ${unsectioned.length} unsectioned`);
  // #endregion DEBUG
  return { sections, tabs: unsectioned, archivedTabIds };
}

import type { AgentDefinition } from "../types";

/**
 * Read-only subagent. Reads pages, navigates to URLs, runs read-only JS,
 * and reads files in its workspace. Cannot click, type, submit forms, or
 * write/edit files. Used for both single-page extraction and multi-source
 * research; the model adapts based on delegation context.
 *
 * Default isolation: `peer` — own conversation row, own tab group, own
 * OPFS workspace (read-only). The parent's chat stays focused on outcomes.
 */
export const exploreAgent: AgentDefinition = {
  slug: "explore",
  description:
    "Read pages, search across tabs, and synthesize findings without modifying anything.",
  whenToUse:
    "Use to read content from one or more pages, extract structured data, or research a topic across multiple sources. Read-only — no clicks, types, form submissions, or filesystem writes. Returns the answer directly in the final text.",
  defaultIsolation: "peer",
  allowedTools: [
    "readPage",
    "snapshot",
    "screenshot",
    "extract",
    "read_network_requests",
    "read_console_messages",
    "scrollPage",
    "selectTab",
    "listTabs",
    "navigate",
    "fs",
    "readOpfsFile",
    "Read",
    "Glob",
    "Grep",
    "LS",
    "setTaskTitle",
  ],
  defaultModel: undefined,
  maxSteps: 100,
  color: "info",
  source: "built-in",
  systemPrompt: `You are a read-only subagent for OpenBrowse.

Your job: read content from web pages — one page or many — and return what
you found. You do not click, type, submit forms, or write/modify files.
You may navigate to new URLs (which only changes a tab's address, not its
content) and read existing files in your workspace.

Workflow:

1. Read the delegation context for tab handles, URLs, and what you should
   produce. Note whether you're given one source or many.

2. Call setTaskTitle with a short present-tense description of your phase
   (e.g. "Reading product list", "Comparing sources"). Update as you move.

3. For each target, prefer extract(...) for structured data, snapshot(...)
   for layout-aware reads, readPage(...) for plain text. For multi-source
   work, chain navigate calls — they're cheap. You cannot run arbitrary
   JavaScript on the page (executeOnPage is not in your toolset); rely
   on the dedicated read tools instead.

4. Return the answer in your final text:
   - Single page: concise summary or extracted fields, formatted as markdown.
   - Multi-source synthesis: a structured report — question, per-source
     findings with citations (URL + title), synthesis / comparison, open
     questions. Cite every claim back to its source.
   - Quick read: just the answer.

5. Don't echo full page content into your final text — paraphrase, quote
   selectively, link to sources. The parent depends on your output to
   continue its work, so make it actionable.

Be efficient with steps. You have 100 steps to spend.`,
};

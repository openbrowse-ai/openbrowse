import { resolveConfirmation } from "@/lib/mcp-host-policy";
import { storage } from "@/lib/storage";

/**
 * Default ms before an unanswered confirmation prompt auto-denies.
 *
 * Overridable per-user via `Settings.mcpAutoDenyMs`. The 60s value is
 * preserved as the fallback to match pre-2026-06-29 behavior for any
 * settings record that doesn't carry the field, and as the value used
 * by the synchronous register-then-resolve path before
 * `getSettings()` resolves.
 */
export const AUTO_DENY_MS = 60_000;

/**
 * Resolve the configured auto-deny timeout. Returns `null` when the
 * user has selected "Never" (`mcpAutoDenyMs <= 0`), `AUTO_DENY_MS` as
 * a safe fallback if the setting read fails for any reason, otherwise
 * the configured positive value.
 */
async function resolveAutoDenyMs(): Promise<number | null> {
  try {
    const s = await storage.getSettings();
    const v = s.mcpAutoDenyMs;
    if (v === undefined) return AUTO_DENY_MS;
    if (v <= 0) return null;
    return v;
  } catch {
    return AUTO_DENY_MS;
  }
}

/**
 * Snapshot subscribers receive on every pending-prompt mutation
 * (add / remove). Returned by `listPendingPrompts()` so a fresh
 * subscriber can render the current state without waiting for the
 * next change.
 */
type PromptListener = (prompts: PendingPrompt[]) => void;
const promptListeners = new Set<PromptListener>();

function notifyPromptListeners(): void {
  const snapshot = listPendingPrompts();
  for (const cb of promptListeners) {
    try {
      cb(snapshot);
    } catch {
      // Defensive: a buggy subscriber must not break confirmation flow.
    }
  }
}

/**
 * Subscribe to pending-prompt list changes. Returns an unsubscribe fn.
 *
 * Used by `mcp-bridge-prompts-port.ts` to push live updates over a
 * long-lived `chrome.runtime.connect` channel to the Settings →
 * MCP Server → Activity surface.
 */
export function onPromptsChange(cb: PromptListener): () => void {
  promptListeners.add(cb);
  return () => {
    promptListeners.delete(cb);
  };
}

export interface PendingPrompt {
  promptId: string;
  clientId: string;
  hostName: string;
  prompt: string;
  targetWindowInfo: { windowId: number; activeTabUrl?: string; spaceName?: string };
  createdAt: number;
}

export type ConfirmationOutcome = "allow" | "deny";

interface PendingEntry extends PendingPrompt {
  resolve: (outcome: ConfirmationOutcome) => void;
  /**
   * The auto-deny timer, or `null` when the user has set
   * `mcpAutoDenyMs <= 0` ("Never") so no timer was armed at all.
   * Stored as a possibly-null union so the entry shape stays uniform.
   */
  timer: ReturnType<typeof setTimeout> | null;
}

const pending = new Map<string, PendingEntry>();

function newPromptId(): string {
  // MV3 service workers expose globalThis.crypto for random bytes; we
  // avoid node:crypto to stay portable across vitest jsdom-node and
  // production SW environments.
  const buf = new Uint8Array(12);
  const c = (globalThis as { crypto?: { getRandomValues(b: Uint8Array): Uint8Array } }).crypto;
  if (c) c.getRandomValues(buf);
  else for (let i = 0; i < buf.length; i++) buf[i] = Math.floor(Math.random() * 256);
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
}

export interface AwaitConfirmationArgs {
  clientId: string;
  hostName: string;
  prompt: string;
  targetWindowInfo: { windowId: number; activeTabUrl?: string; spaceName?: string };
  hostRequest: "auto" | "prompt";
  /**
   * Optional callback fired the moment a pending entry is registered
   * in the store (i.e. when the resolved outcome is `prompt`).
   * Receives the freshly-minted `promptId`.
   *
   * Used by the async-dispatch `task` handler to stash the promptId
   * on its `tasksStore` row so `cancel_task` can dismiss the prompt
   * as deny if the host cancels before the user decides.
   *
   * NOT called when the outcome resolves to `auto` (no prompt is
   * registered) or `host_blocked` (the call throws).
   */
  onPromptRegistered?: (promptId: string) => void;
}

export async function awaitConfirmation(args: AwaitConfirmationArgs): Promise<ConfirmationOutcome> {
  const outcome = await resolveConfirmation(args.clientId, args.hostRequest);
  if (outcome === "host_blocked") {
    throw new Error(`host_blocked: client ${args.clientId} is blocked by user policy`);
  }
  if (outcome === "auto") return "allow";

  // outcome === "prompt": register pending entry and wait
  const promptId = newPromptId();
  // Resolve auto-deny timeout once at registration time. Reading
  // settings here keeps the prompt insensitive to the user changing
  // the timeout while a prompt is already pending — surprising
  // behaviour otherwise, since shortening the timeout could
  // retroactively auto-deny an in-flight prompt.
  const autoDenyMs = await resolveAutoDenyMs();
  return new Promise<ConfirmationOutcome>((resolve) => {
    const entry: PendingEntry = {
      promptId,
      clientId: args.clientId,
      hostName: args.hostName,
      prompt: args.prompt,
      targetWindowInfo: args.targetWindowInfo,
      createdAt: Date.now(),
      resolve,
      // autoDenyMs === null means the user picked "Never": no timer is
      // armed and the prompt waits indefinitely.
      timer:
        autoDenyMs === null
          ? null
          : setTimeout(() => {
              if (pending.has(promptId)) {
                pending.delete(promptId);
                notifyPromptListeners();
                resolve("deny");
              }
            }, autoDenyMs),
    };
    pending.set(promptId, entry);
    notifyPromptListeners();
    if (args.onPromptRegistered) {
      try {
        args.onPromptRegistered(promptId);
      } catch {
        // Defensive: caller bug must not break confirmation flow.
      }
    }
    // Notify any UI listeners (the Background Tasks panel).
    const publicEntry: PendingPrompt = {
      promptId,
      clientId: args.clientId,
      hostName: args.hostName,
      prompt: args.prompt,
      targetWindowInfo: args.targetWindowInfo,
      createdAt: entry.createdAt,
    };
    try {
      const result = chrome.runtime.sendMessage({
        type: "MCP_BRIDGE_PROMPT_ADDED",
        prompt: publicEntry,
      });
      if (result && typeof (result as Promise<unknown>).catch === "function") {
        void (result as Promise<unknown>).catch(() => {});
      }
    } catch {
      // ignore in tests
    }
  });
}

export function confirmPrompt(promptId: string, outcome: ConfirmationOutcome): boolean {
  const entry = pending.get(promptId);
  if (!entry) return false;
  if (entry.timer !== null) clearTimeout(entry.timer);
  pending.delete(promptId);
  entry.resolve(outcome);
  notifyPromptListeners();
  return true;
}

export function listPendingPrompts(): PendingPrompt[] {
  return Array.from(pending.values()).map((e) => ({
    promptId: e.promptId,
    clientId: e.clientId,
    hostName: e.hostName,
    prompt: e.prompt,
    targetWindowInfo: e.targetWindowInfo,
    createdAt: e.createdAt,
  }));
}

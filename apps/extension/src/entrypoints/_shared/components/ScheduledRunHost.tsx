// src/entrypoints/_shared/components/ScheduledRunHost.tsx
//
// Hosts scheduled-task agent runs as BACKGROUND chats inside the home app.
//
// Architectural note (post-SW-host migration, 2026-06-25): the agent loop
// no longer runs in this realm. The `useAgentChat` hook below now uses
// `RemoteChatTransport`, which proxies to the service-worker agent host.
// The home tab's role here is reduced to: maintain the per-conversation
// `RemoteChatTransport` Port, claim the run via session-storage
// first-writer-wins (so only one home tab drives any given scheduled
// run), and post SCHEDULED_RUN_DONE back to the scheduler when the SW
// emits the terminal-state chunk.
//
// Deleting this component entirely is possible (the SW could start the
// run directly without a renderer), but doing so requires the SW to
// synthesize the per-task `settingsSnapshot` from `taskDb` and bridge
// it into `agent-host/run.ts`. That work is deferred; the current
// home-tab indirection preserves all existing semantics while still
// giving scheduled runs the SW-host pause-immunity benefit (the loop
// itself runs in the SW even though it was kicked off from this
// component).
//
// The service worker, when a task fires, ensures a home page exists, records
// the pending run in chrome.storage.session, and broadcasts SCHEDULER_HOST_RUN.
// This host claims each run (first-writer-wins, so multiple open home pages
// don't double-run it) and mounts a hidden ScheduledRunInstance to drive it.

import { useCallback, useEffect, useRef, useState } from "react";
import { useAgentChat } from "@/hooks/useAgentChat";
import { taskDb } from "@/lib/schedule/task-db";
import { clearHeadlessRunPolicy } from "@/lib/agent/agent-transport";
import {
  extractTextContent,
  serializeParts,
} from "@/lib/agent/serialize-parts";

const PENDING_RUNS_KEY = "scheduled-pending-runs";
const CLAIM_KEY_PREFIX = "scheduled-run-claim:";

interface PendingRun {
  childConversationId: string;
  taskId: string;
}

/** Read the set of pending runs the SW has queued. */
async function readPendingRuns(): Promise<PendingRun[]> {
  try {
    const r = await chrome.storage.session.get(PENDING_RUNS_KEY);
    const list = r[PENDING_RUNS_KEY];
    return Array.isArray(list) ? (list as PendingRun[]) : [];
  } catch {
    return [];
  }
}

/**
 * Try to claim a run for THIS page. First-writer-wins via a session-storage
 * flag keyed by childConversationId. Returns true if we won the claim.
 */
async function claimRun(childConversationId: string): Promise<boolean> {
  const key = `${CLAIM_KEY_PREFIX}${childConversationId}`;
  try {
    const existing = await chrome.storage.session.get(key);
    if (existing[key]) return false;
    // Best-effort claim. There's an unavoidable tiny TOCTOU window across
    // pages, but the SW running-guard + dedupe make double-run benign-rare.
    await chrome.storage.session.set({ [key]: Date.now() });
    return true;
  } catch {
    return false;
  }
}

// Serialize all mutations of PENDING_RUNS_KEY through a single promise chain.
// releaseRunRecord does a read-modify-write on session storage; two runs
// finishing near-simultaneously could otherwise interleave and reinsert a
// just-removed run. Chaining makes each read-modify-write atomic within the
// page.
let pendingRunsLock: Promise<void> = Promise.resolve();

function serializePendingRunsOp(op: () => Promise<void>): Promise<void> {
  const run = pendingRunsLock.then(op, op);
  pendingRunsLock = run.then(
    () => {},
    () => {},
  );
  return run;
}

async function releaseRunRecord(childConversationId: string): Promise<void> {
  const key = `${CLAIM_KEY_PREFIX}${childConversationId}`;
  try {
    await chrome.storage.session.remove(key);
  } catch {
    // ignore
  }
  await serializePendingRunsOp(async () => {
    try {
      const pending = await readPendingRuns();
      const next = pending.filter(
        (p) => p.childConversationId !== childConversationId,
      );
      await chrome.storage.session.set({ [PENDING_RUNS_KEY]: next });
    } catch {
      // ignore
    }
  });
}

export function ScheduledRunHost() {
  // Runs this page has claimed and is hosting.
  const [hosted, setHosted] = useState<PendingRun[]>([]);
  const hostedIdsRef = useRef<Set<string>>(new Set());

  const tryHost = useCallback(async (run: PendingRun) => {
    if (hostedIdsRef.current.has(run.childConversationId)) return;
    const won = await claimRun(run.childConversationId);
    if (!won) return;
    hostedIdsRef.current.add(run.childConversationId);
    setHosted((prev) => [...prev, run]);
  }, []);

  // On mount: scan storage for runs queued before this page loaded.
  useEffect(() => {
    void readPendingRuns().then((runs) => {
      for (const run of runs) void tryHost(run);
    });
  }, [tryHost]);

  // Live: pick up runs requested while this page is open.
  useEffect(() => {
    function onMessage(msg: unknown) {
      if (typeof msg !== "object" || msg === null) return;
      const m = msg as {
        type?: string;
        childConversationId?: string;
        taskId?: string;
      };
      if (
        m.type === "SCHEDULER_HOST_RUN" &&
        m.childConversationId &&
        m.taskId
      ) {
        void tryHost({
          childConversationId: m.childConversationId,
          taskId: m.taskId,
        });
      }
    }
    chrome.runtime.onMessage.addListener(onMessage);
    return () => chrome.runtime.onMessage.removeListener(onMessage);
  }, [tryHost]);

  const handleFinished = useCallback((childConversationId: string) => {
    void releaseRunRecord(childConversationId);
    // Drop the per-conversation headless policy registered by the transport
    // so the (module-global, home-realm) policy map doesn't grow unbounded
    // across runs. Safe: sched-run conversation ids are single-use.
    clearHeadlessRunPolicy(childConversationId);
    hostedIdsRef.current.delete(childConversationId);
    setHosted((prev) =>
      prev.filter((r) => r.childConversationId !== childConversationId),
    );
  }, []);

  return (
    <>
      {hosted.map((run) => (
        <ScheduledRunInstance
          key={run.childConversationId}
          taskId={run.taskId}
          childConversationId={run.childConversationId}
          onFinished={handleFinished}
        />
      ))}
    </>
  );
}

interface InstanceProps {
  taskId: string;
  childConversationId: string;
  onFinished: (childConversationId: string) => void;
}

/**
 * Drives ONE scheduled run as a background chat via the real useAgentChat
 * path. Renders nothing. Auto-sends the task prompt once and posts
 * SCHEDULED_RUN_DONE when the run reaches a terminal state.
 */
function ScheduledRunInstance({
  taskId,
  childConversationId,
  onFinished,
}: InstanceProps) {
  const [prompt, setPrompt] = useState<string | null>(null);
  const [autoApprove, setAutoApprove] = useState(false);
  const [model, setModel] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void taskDb
      .get(taskId)
      .then((task) => {
        if (cancelled) return;
        if (!task) {
          reportDone(childConversationId, "error", "", "Task not found.");
          onFinished(childConversationId);
          return;
        }
        setPrompt(task.prompt);
        setAutoApprove(task.autoApprove ?? false);
        setModel(task.agentModel);
        setLoaded(true);
      })
      .catch((err) => {
        if (cancelled) return;
        // taskDb.get rejected (e.g. IDB unavailable). Don't leave the run
        // claimed and silently stuck — report failure and release it.
        reportDone(
          childConversationId,
          "error",
          "",
          `Task retrieval failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        onFinished(childConversationId);
      });
    return () => {
      cancelled = true;
    };
  }, [taskId, childConversationId, onFinished]);

  const {
    input,
    setInput,
    handleSubmit,
    isLoading,
    messages,
    isConfigured,
    isReady,
  } = useAgentChat({
    conversationId: childConversationId,
    spaceId: null,
    onNewConversation: () => {},
    headless: { autoApprove },
    // Force the task's model for THIS run only — never persist it to the
    // user's global agent settings (which setAgentModel would do).
    modelOverride: model,
  });

  // Auto-send the prompt exactly once, but only after the chat transport has
  // finished building (`isReady`). The transport is constructed asynchronously;
  // sending before it exists falls through to the AI SDK's default `api/chat`
  // endpoint (ERR_FILE_NOT_FOUND in the extension), failing the run instantly.
  const startedRef = useRef(false);
  useEffect(() => {
    if (startedRef.current) return;
    if (!loaded || !prompt || !isConfigured || !isReady) return;
    if (input !== prompt) {
      setInput(prompt);
      return;
    }
    startedRef.current = true;
    void handleSubmit();
  }, [loaded, prompt, isConfigured, isReady, input, setInput, handleSubmit, childConversationId]);

  // Terminal detection: only report done after a REAL run cycle — i.e. once
  // we've observed isLoading become true (the run actually started) and then
  // false. Without the `hasStreamed` gate, the effect fires immediately after
  // handleSubmit (before isLoading flips true) and falsely reports done.
  const hasStreamedRef = useRef(false);
  const reportedRef = useRef(false);
  useEffect(() => {
    if (!startedRef.current || reportedRef.current) return;
    if (isLoading) {
      hasStreamedRef.current = true;
      return;
    }
    if (!hasStreamedRef.current) return; // not started streaming yet
    reportedRef.current = true;
    const lastAssistant = [...messages]
      .reverse()
      .find((m) => m.role === "assistant");
    const finalText = lastAssistant
      ? extractTextContent(serializeParts(lastAssistant.parts)).trim()
      : "";
    reportDone(
      childConversationId,
      finalText.length > 0 ? "success" : "error",
      finalText,
      finalText.length > 0
        ? undefined
        : "Run ended without a final summary (possible stall).",
    );
    onFinished(childConversationId);
  }, [isLoading, messages, childConversationId, onFinished]);

  return null;
}

function reportDone(
  childConversationId: string,
  status: "success" | "error",
  finalText: string,
  errorMessage?: string,
): void {
  chrome.runtime
    ?.sendMessage?.({
      type: "SCHEDULED_RUN_DONE",
      childConversationId,
      status,
      finalText,
      errorMessage,
    })
    ?.catch?.(() => {});
}

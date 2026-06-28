/**
 * Single source of truth for the "OpenBrowse is working on this tab" overlay
 * (animated glow border + input-blocking shield + pill).
 *
 * Per-tab state: each working tab carries its own (color, owningConversationId).
 * Under SW-host the agent loop runs in the SW, and multiple sources may drive
 * indicators concurrently:
 *
 *   - N parallel top-level conversations (different `conversationId`s, often
 *     different Spaces → different colors).
 *   - One conversation spawning N parallel subagents via `delegate`. The parent
 *     and each subagent each have their own `conversationId` and each can be
 *     driving a distinct working tab simultaneously.
 *
 * The single-slot globals this module used pre-refactor (`currentSpaceColor`
 * and `lastIndicatorTabId`) clobbered each other in either case. The state is
 * now a `Map<tabId, IndicatorState>`. `resetAgentIndicator(conversationId)`
 * only tears down tabs owned by that cid, so a peer subagent's overlay isn't
 * cleared when the parent (or another peer) finishes.
 *
 * Color is now a required call-site argument: callers know their conversation
 * context (the agent-transport tool wrapper threads `agentConversationId`; the
 * CUA loop receives `spaceColor` through `CuaRunConfig`), so they resolve the
 * color synchronously. No more cross-realm `AGENT_SPACE_COLOR_SET` bridge.
 */
import { getTargetTabId, sendToContentScript } from "./active-tab";
import { startCapture } from "./cdp-capture";

interface IndicatorState {
  /** Glow tint applied to the overlay; null = default (untinted). */
  color: string | null;
  /** Conversation that last claimed this tab. `resetAgentIndicator(cid)` only
   *  clears tabs whose `owningConversationId === cid`. */
  owningConversationId: string | null;
}

/**
 * Live indicator state, keyed by tabId. An entry exists iff that tab currently
 * shows the working overlay. Entries are removed on idle notifications and on
 * `resetAgentIndicator` (selectively, by cid).
 */
const indicatorStateByTab = new Map<number, IndicatorState>();

/** Per-tab serialization queue: notifyAgentStatus calls on the same tab run
 *  in order; calls on different tabs run in parallel. */
const tabQueues = new Map<number, Promise<void>>();

/** Per-cid tab tracker: lets `resetAgentIndicator(cid)` iterate only the tabs
 *  that cid owns, without scanning the whole `indicatorStateByTab` map. */
const tabsByConversation = new Map<string, Set<number>>();

function rememberOwnership(tabId: number, conversationId: string | null): void {
  if (conversationId == null) return;
  let set = tabsByConversation.get(conversationId);
  if (!set) {
    set = new Set();
    tabsByConversation.set(conversationId, set);
  }
  set.add(tabId);
}

function forgetOwnership(tabId: number, conversationId: string | null): void {
  if (conversationId == null) return;
  const set = tabsByConversation.get(conversationId);
  if (!set) return;
  set.delete(tabId);
  if (set.size === 0) tabsByConversation.delete(conversationId);
}

/** Pump fn through the tab's serial queue; runs after any prior pending op
 *  on the same tab. */
function enqueueForTab(tabId: number, fn: () => Promise<void>): Promise<void> {
  const prior = tabQueues.get(tabId) ?? Promise.resolve();
  const next = prior.then(fn, fn).catch(() => {});
  tabQueues.set(tabId, next);
  // Clean up the queue entry once it settles, so we don't grow unbounded.
  void next.then(() => {
    if (tabQueues.get(tabId) === next) tabQueues.delete(tabId);
  });
  return next;
}

export interface NotifyAgentStatusOptions {
  /** The tab the indicator targets. When omitted, falls back to
   *  `getTargetTabId()`. Idle notifications without `tabId` are no-ops. */
  tabId?: number | null;
  /** Glow tint. `undefined` keeps any prior tint on the same tab (no-change);
   *  `null` clears the tint to the default. */
  color?: string | null;
  /** Conversation owning this overlay. Required for correct ownership
   *  bookkeeping (`resetAgentIndicator(cid)` to find this tab). */
  conversationId?: string | null;
}

/**
 * Show or hide the blocking "working" overlay on the agent's work tab.
 *
 * @param working  true to show, false to hide.
 * @param opts     `{ tabId, color, conversationId }`. See type.
 *
 * The overlay is delivered via `sendToContentScript`, which injects the
 * content script if missing and retries. Internal pages (`chrome://`,
 * `chrome-extension://`, `devtools://`) are skipped because they can't host
 * the content script.
 */
export function notifyAgentStatus(
  working: boolean,
  opts: NotifyAgentStatusOptions = {},
): Promise<void> {
  const requestedTabId = opts.tabId ?? getTargetTabId();
  if (requestedTabId == null) {
    // No resolvable tab — nothing to do. Idle notifications without a tabId
    // are also no-ops; per-tab state can't be cleared without knowing which
    // tab to clear. (Callers that need broad teardown use
    // `resetAgentIndicator(cid)`.)
    return Promise.resolve();
  }
  const targetTabId = requestedTabId;
  // Distinguish three states for the conversationId:
  //   - key absent (undefined): caller doesn't know the cid; preserve
  //     the prior owner so `resetAgentIndicator(cid)` lookup still works.
  //   - key present, null: caller asserts no owner.
  //   - key present, string: caller claims ownership for this cid.
  // The previous `opts.conversationId ?? null` collapsed undefined and
  // null into the same value, which stripped prior ownership when a
  // refresh call omitted the field.
  const hasExplicitCid = "conversationId" in opts;
  const cid = hasExplicitCid ? (opts.conversationId ?? null) : null;
  const requestedColor = opts.color;

  return enqueueForTab(targetTabId, async () => {
    try {
      let url = "";
      try {
        const tab = await chrome.tabs.get(targetTabId);
        url = tab.url ?? "";
      } catch {
        // Tab gone; drop any stale state but don't try to send.
        const prior = indicatorStateByTab.get(targetTabId);
        if (prior) {
          forgetOwnership(targetTabId, prior.owningConversationId);
          indicatorStateByTab.delete(targetTabId);
        }
        return;
      }
      const isInternalUrl =
        url.startsWith("chrome://") ||
        url.startsWith("chrome-extension://") ||
        url.startsWith("devtools://");
      if (isInternalUrl && working) {
        // Internal page — no content script possible. Skip without
        // mutating state so a later navigation to a normal page picks
        // up cleanly. (For idle calls we DO clean up below.)
        return;
      }

      if (working) {
        const prior = indicatorStateByTab.get(targetTabId);
        // Resolve effective color: explicit value wins; `undefined` keeps the
        // prior tint; missing prior means default.
        const color =
          requestedColor === undefined
            ? (prior?.color ?? null)
            : requestedColor;

        if (hasExplicitCid) {
          // Ownership swap: if a different cid owned this tab, forget
          // that ownership (the new cid takes it over). Same-cid claims
          // preserve ownership without churn. Only apply when the
          // caller actually passed a cid (explicit null counts: it
          // means "claim this tab for nobody").
          if (prior && prior.owningConversationId !== cid) {
            forgetOwnership(targetTabId, prior.owningConversationId);
          }
          rememberOwnership(targetTabId, cid);
          indicatorStateByTab.set(targetTabId, {
            color,
            owningConversationId: cid,
          });
        } else if (prior) {
          // No cid provided AND there's a prior entry. Refresh color
          // only; preserve the existing owner.
          indicatorStateByTab.set(targetTabId, {
            color,
            owningConversationId: prior.owningConversationId,
          });
        } else {
          // No cid provided AND no prior entry. Set with no owner.
          indicatorStateByTab.set(targetTabId, {
            color,
            owningConversationId: null,
          });
        }

        // If this conversation previously claimed a DIFFERENT tab, clear the
        // overlay on that prior tab so the run doesn't leave it lingering.
        // Iterate the cid's tab set (cheap; usually 1-2 entries) so peer
        // conversations' tabs are not disturbed.
        if (cid != null) {
          const cidTabs = tabsByConversation.get(cid);
          if (cidTabs) {
            for (const otherTabId of Array.from(cidTabs)) {
              if (otherTabId === targetTabId) continue;
              const otherState = indicatorStateByTab.get(otherTabId);
              if (otherState?.owningConversationId === cid) {
                // Clear the prior tab via its own serial queue so we don't
                // race the current tab's enqueued send.
                //
                // Re-check ownership INSIDE the queued callback: by the
                // time it runs, a peer cid may have claimed `otherTabId`
                // ahead of us in `otherTabId`'s serial queue, and tearing
                // down the peer's overlay would be wrong.
                void enqueueForTab(otherTabId, async () => {
                  const liveState = indicatorStateByTab.get(otherTabId);
                  if (liveState?.owningConversationId !== cid) {
                    // Ownership changed — skip the teardown.
                    return;
                  }
                  await sendToContentScript(otherTabId, {
                    type: "CHAT_CUA_WORKING_STATE",
                    active: false,
                  }).catch(() => {});
                  indicatorStateByTab.delete(otherTabId);
                  forgetOwnership(otherTabId, cid);
                });
              }
            }
          }
        }

        // Begin network/console capture on the worked tab (idempotent).
        void startCapture(targetTabId).catch(() => {});

        await sendToContentScript(targetTabId, {
          type: "CHAT_CUA_WORKING_STATE",
          active: true,
          color,
        }).catch(() => {});

        chrome.runtime
          .sendMessage({
            type: "AGENT_TAB_WORKING",
            tabId: targetTabId,
            color,
          })
          .catch(() => {});
      } else {
        // Idle / reset path. For internal pages we cannot send the
        // CHAT_CUA_WORKING_STATE message (no content script there) but
        // we MUST still drop our local state + broadcast AGENT_TAB_IDLE
        // so the SW mirror in `background/index.ts` doesn't leak a
        // stale "tab still working" entry after the tab navigated.
        const prior = indicatorStateByTab.get(targetTabId);
        if (!isInternalUrl) {
          // Always send the clear message on idle — even if our local map
          // has no record (e.g. SW restart between working/idle on a long
          // run, or a renderer-side helper firing for tear-down on the
          // wrong realm). It's cheap and the receiver tolerates no-op
          // clears.
          await sendToContentScript(targetTabId, {
            type: "CHAT_CUA_WORKING_STATE",
            active: false,
          }).catch(() => {});
        }
        if (prior) {
          forgetOwnership(targetTabId, prior.owningConversationId);
          indicatorStateByTab.delete(targetTabId);
        }
        chrome.runtime
          .sendMessage({
            type: "AGENT_TAB_IDLE",
            tabId: targetTabId,
          })
          .catch(() => {});
      }
    } catch {
      // no resolvable tab
    }
  });
}

/**
 * Clear every overlay owned by `conversationId`. Used by the SW run host's
 * terminal-state hook to make sure a finished or aborted run leaves no
 * overlay behind, WITHOUT disturbing peer overlays (sibling subagents, other
 * parallel conversations).
 *
 * Peer-safe: only iterates the cid's own tab set. Tabs owned by a different
 * cid are untouched even if they happen to be on the same target tab id
 * (extremely rare, but possible if a peer claimed the same tab between this
 * call's enqueue and its execution).
 *
 * Returns a Promise that resolves once all per-tab serial queues have
 * drained — useful in tests, never load-bearing in production.
 */
export function resetAgentIndicator(conversationId?: string | null): Promise<void> {
  if (conversationId == null) {
    // Broad reset: every tab. Used by tests and as a defensive sweep when
    // the caller has no cid handy.
    const tabs = Array.from(indicatorStateByTab.keys());
    return Promise.all(tabs.map((tid) => notifyAgentStatus(false, { tabId: tid }))).then(
      () => {},
    );
  }
  const owned = tabsByConversation.get(conversationId);
  if (!owned) return Promise.resolve();
  const snapshot = Array.from(owned);
  return Promise.all(
    snapshot.map((tabId) => {
      const state = indicatorStateByTab.get(tabId);
      // Defensive: only clear if THIS cid still owns the tab at clear time.
      // Without this, a tab whose ownership was transferred to a peer
      // between cid-A's enqueue and cid-A's clear would have its peer's
      // overlay torn down.
      if (state?.owningConversationId !== conversationId) {
        forgetOwnership(tabId, conversationId);
        return Promise.resolve();
      }
      return notifyAgentStatus(false, { tabId, conversationId });
    }),
  ).then(() => {});
}

/**
 * Test-only: reset all internal state. NOT exported through the public API.
 * Tests import this via `__resetForTests` to start with a clean slate
 * between cases. Production never calls this.
 */
export function __resetForTests(): void {
  indicatorStateByTab.clear();
  tabQueues.clear();
  tabsByConversation.clear();
}

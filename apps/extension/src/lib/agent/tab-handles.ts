/**
 * Per-conversation handle map. Handles (`t1`, `t2`, ...) are stable agent-
 * facing identifiers that map to chrome tab ids. Tools take a handle in
 * their `tab` arg; the session resolves it back to a real tab id.
 *
 * State is split:
 *   - In-memory (`maps`): fast sync access used by the tools' execute path
 *     and the session-helper getters threaded through ToolContext.
 *   - chatDb-backed (`conversation.handleState`): survives service-worker
 *     restarts and the conversation list re-mount cycle. Only handles for
 *     the conversation's owned tabs are persisted; ephemeral handles
 *     minted for non-owned tabs (e.g. from `listTabs`) live only in memory.
 *
 * The sync API (`getOrCreateHandle`, `resolveHandle`) reads from the
 * in-memory map only. Hydration (`loadHandlesForConversation`) is
 * fire-and-forget from `setAgentContext`; it merges restored state into
 * whatever in-memory state the running agent has already accumulated, so
 * a handle minted before hydration completes is never lost. Persistence
 * is fire-and-forget on every mutation, debounced+chained per conversation.
 */

import { chatDb, type PersistedHandleState } from "@/lib/chat-db";

export interface TabHandle {
  handle: string;
  chromeTabId: number;
}

interface HandleMap {
  handleToTab: Map<string, number>;
  tabToHandle: Map<number, string>;
  counter: number;
}

const maps = new Map<string, HandleMap>();

/** In-flight hydration promises, keyed by conversation id. */
const hydrationPromises = new Map<string, Promise<void>>();

/**
 * In-flight persist chains, keyed by conversation id. We chain writes so
 * concurrent mutations serialize and tests can deterministically await the
 * latest one. Entries auto-clean themselves once the chain settles AND no
 * newer write has been queued — see the `.finally` in `persist()`.
 */
const persistChains = new Map<string, Promise<void>>();

/**
 * Set of conversation ids that have a queued-but-not-yet-started persist
 * write. Used to coalesce: when many mutations happen in quick succession
 * (e.g. `listTabs` minting handles for 20 tabs), only one chatDb round-trip
 * needs to run — it'll read the latest in-memory state when it executes.
 */
const persistDirty = new Set<string>();

function emptyMap(): HandleMap {
  return { handleToTab: new Map(), tabToHandle: new Map(), counter: 1 };
}

function getMap(conversationId: string): HandleMap {
  let map = maps.get(conversationId);
  if (!map) {
    map = emptyMap();
    maps.set(conversationId, map);
  }
  return map;
}

/**
 * Project the in-memory map to a chatDb-shaped record, including only
 * handles whose tabId is in `ownedSet`. Non-owned handles (e.g. minted
 * while enumerating `listTabs` for the user's other tabs) stay in memory
 * but don't bloat chatDb across SW lifetimes.
 */
function snapshotOwned(
  map: HandleMap,
  ownedSet: Set<number>,
): PersistedHandleState {
  const handles: Record<string, number> = {};
  for (const [h, id] of map.handleToTab) {
    if (ownedSet.has(id)) handles[h] = id;
  }
  return { handles, counter: map.counter };
}

function restore(state: PersistedHandleState | undefined): HandleMap {
  if (!state) return emptyMap();
  const map = emptyMap();
  for (const [h, id] of Object.entries(state.handles)) {
    map.handleToTab.set(h, id);
    map.tabToHandle.set(id, h);
  }
  // Defensive: clamp the stored counter to a finite positive integer (in
  // case chatDb was tampered with or partially written). If somehow lower
  // than the highest seen handle suffix, advance it so newly-minted
  // handles can't collide.
  let maxSeen = 0;
  for (const h of map.handleToTab.keys()) {
    const m = h.match(/^t(\d+)$/);
    if (m) maxSeen = Math.max(maxSeen, Number(m[1]));
  }
  const cleanCounter =
    Number.isFinite(state.counter) && state.counter > 0 ? state.counter : 1;
  map.counter = Math.max(cleanCounter, maxSeen + 1);
  return map;
}

/**
 * Persist the in-memory handle map for a conversation back to chatDb.
 * Fire-and-forget; failures are swallowed. Writes are chained per
 * conversation so concurrent calls serialize (and so tests can
 * deterministically await `flushPersistsForTests`). Only handles whose
 * tabId is in the conversation's `ownedTabIds` are written; ephemeral
 * handles minted by `listTabs` for non-owned tabs stay in memory only.
 *
 * Calls are coalesced: if a write is already queued (pending), additional
 * persist() calls before it starts return early. The pending write reads
 * latest in-memory state when it executes, so no mutation is lost.
 *
 * The chain re-checks `maps.get(conversationId)` after every async hop.
 * If the conversation was cleared (`clearHandles`) mid-flight — including
 * across a chatDb reset in tests — the chain aborts before writing
 * anything stale.
 */
function persist(conversationId: string): void {
  const map = maps.get(conversationId);
  if (!map) return;
  if (persistDirty.has(conversationId)) return; // coalesce: a write is already queued
  persistDirty.add(conversationId);
  const prev = persistChains.get(conversationId) ?? Promise.resolve();
  const next = prev
    .catch(() => {}) // never let a previous failure cancel later writes
    .then(async () => {
      // Claim the dirty flag *before* the await so subsequent mutations
      // queue a fresh write rather than getting silently dropped by the
      // coalesce check above.
      persistDirty.delete(conversationId);
      if (!maps.has(conversationId)) return; // cleared before we ran
      const conv = await chatDb.getConversation(conversationId);
      // Re-check after the chatDb read: clearHandles may have been called
      // while we were suspended.
      const liveMap = maps.get(conversationId);
      if (!liveMap) return;
      const ownedSet = new Set(conv?.ownedTabIds ?? []);
      const state = snapshotOwned(liveMap, ownedSet);
      // Last guard before the write — chatDb may have been reset between
      // the read and the write (only happens in tests, but trivially safe
      // to check).
      if (!maps.has(conversationId)) return;
      await chatDb.updateConversation(conversationId, { handleState: state });
    })
    .catch((err) => {
      console.warn("[tab-handles] persist failed", err);
    })
    .finally(() => {
      // Drop the chain entry only if no newer write piggy-backed on us.
      // Otherwise the newer write is still pending and persistChains points
      // at IT, not us — leave it alone.
      if (persistChains.get(conversationId) === next) {
        persistChains.delete(conversationId);
      }
    });
  persistChains.set(conversationId, next);
}

/**
 * Test helper: await the in-flight persist chain for a conversation. Allows
 * tests to assert on chatDb state without timing-based flushes. Production
 * code never waits on persistence.
 */
export function flushPersistsForTests(
  conversationId: string,
): Promise<void> {
  return persistChains.get(conversationId) ?? Promise.resolve();
}

/**
 * Hydrate the in-memory handle map for a conversation from chatDb. Drops
 * any persisted handle whose tab no longer exists. Idempotent: subsequent
 * calls return the same in-flight promise until it settles.
 *
 * Merges restored state into any existing in-memory map for the
 * conversation rather than replacing it, so handles minted between
 * `setAgentContext` and the chatDb read landing aren't lost.
 *
 * Called fire-and-forget from `setAgentContext`. Tests can `await` the
 * returned promise for deterministic ordering.
 *
 * If `clearHandles(conversationId)` is called while hydration is in
 * flight, the hydration cancels its merge step on completion (the
 * cleared state takes precedence over the now-stale persisted snapshot).
 */
export function loadHandlesForConversation(
  conversationId: string,
): Promise<void> {
  const existing = hydrationPromises.get(conversationId);
  if (existing) return existing;

  // Forward-declare so the closure can verify it wasn't cleared.
  let token!: Promise<void>;
  token = (async () => {
    try {
      const conv = await chatDb.getConversation(conversationId);
      const restored = restore(conv?.handleState);

      // Prune dead tabs so a stale handle can't resolve to a closed tab.
      const tabIds = Array.from(restored.tabToHandle.keys());
      const liveness = await Promise.all(
        tabIds.map((id) => {
          // `chrome` is a free identifier on extension globals; in tests
          // / non-extension contexts it may be undefined entirely. Use a
          // typeof guard before any property access.
          const chromeRef =
            typeof chrome !== "undefined" ? chrome : undefined;
          if (!chromeRef?.tabs?.get) {
            // No chrome.tabs available (tests / non-extension context).
            // Treat all persisted handles as live; tests can override
            // per case via vi.stubGlobal.
            return Promise.resolve(true);
          }
          return chromeRef.tabs
            .get(id)
            .then(() => true)
            .catch(() => false);
        }),
      );

      // If we were cleared mid-flight, abort: the new state owns the
      // conversation now and we shouldn't repopulate maps with stale
      // persisted entries.
      if (hydrationPromises.get(conversationId) !== token) return;

      // Merge into the existing in-memory map (creating one if needed).
      // Crucially we do NOT overwrite freshly-minted handles that the
      // running agent already added between setAgentContext and this
      // promise settling.
      const live = getMap(conversationId);
      let pruned = false;
      tabIds.forEach((id, i) => {
        if (!liveness[i]) {
          pruned = true;
          return;
        }
        const handle = restored.tabToHandle.get(id)!;
        // Only adopt the restored binding if neither side is already
        // claimed in-memory (the live map wins).
        if (live.handleToTab.has(handle)) return;
        if (live.tabToHandle.has(id)) return;
        live.handleToTab.set(handle, id);
        live.tabToHandle.set(id, handle);
      });
      live.counter = Math.max(live.counter, restored.counter);

      // If we pruned anything, write the pruned snapshot back so the
      // next cold-start doesn't re-pay the liveness round-trip on dead ids.
      if (pruned) persist(conversationId);
    } catch (err) {
      console.warn("[tab-handles] hydrate failed", err);
      // Leave the in-memory map as whatever was already there (or empty).
    } finally {
      if (hydrationPromises.get(conversationId) === token) {
        hydrationPromises.delete(conversationId);
      }
    }
  })();

  hydrationPromises.set(conversationId, token);
  return token;
}

export function getOrCreateHandle(
  conversationId: string,
  tabId: number,
): string {
  const map = getMap(conversationId);
  const existing = map.tabToHandle.get(tabId);
  if (existing) return existing;

  const handle = `t${map.counter++}`;
  map.handleToTab.set(handle, tabId);
  map.tabToHandle.set(tabId, handle);
  persist(conversationId);
  return handle;
}

export function resolveHandle(
  conversationId: string,
  handle: string,
): number | undefined {
  return maps.get(conversationId)?.handleToTab.get(handle);
}

/**
 * Clear all handle state for a conversation. Called when the agent context
 * switches conversations (`setAgentContext`) so a stale in-memory map from
 * a different conversation can't leak into the new one. Persisted state in
 * chatDb is left intact for the next time the conversation is activated.
 */
export function clearHandles(conversationId: string): void {
  maps.delete(conversationId);
  hydrationPromises.delete(conversationId);
  persistDirty.delete(conversationId);
}

/**
 * List the live `{handle, tabId}` pairs for a conversation. Used by the
 * system-prompt tab-legend renderer. Reads only from the in-memory map —
 * call `loadHandlesForConversation` first if you need post-restart state.
 */
export function listHandles(
  conversationId: string,
): { handle: string; tabId: number }[] {
  const map = maps.get(conversationId);
  if (!map) return [];
  return Array.from(map.handleToTab, ([handle, tabId]) => ({ handle, tabId }));
}

/**
 * Drop a single handle (e.g. when its tab is closed). Idempotent.
 */
export function dropTab(tabId: number): void {
  for (const [conversationId, map] of maps) {
    const handle = map.tabToHandle.get(tabId);
    if (handle) {
      map.handleToTab.delete(handle);
      map.tabToHandle.delete(tabId);
      persist(conversationId);
    }
  }
}

// Auto-cleanup when chrome closes a tab. Best-effort; in non-extension
// contexts (tests) `chrome.tabs` is undefined and we no-op.
if (typeof chrome !== "undefined" && chrome.tabs?.onRemoved?.addListener) {
  chrome.tabs.onRemoved.addListener((tabId) => {
    dropTab(tabId);
  });
}

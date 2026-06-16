/**
 * Per-conversation handle map. Handles (`t1`, `t2`, ...) are stable agent-
 * facing identifiers that map to LogicalTabIds (UUIDs). Tools take a handle
 * in their `tab` arg; the session resolves it to an ltid, and the
 * `tab-registry` resolves the ltid to a live chrome tab id at the very last
 * moment (immediately before each CDP call).
 *
 * Keying on ltid rather than chrome.tabs.id is what makes handles survive
 * `chrome.tabs.onReplaced` (Speculation Rules / prerender activation), which
 * would otherwise silently renumber the tab id mid-flow and break the
 * agent's grip on the page.
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
import { tabRegistry, type LogicalTabId } from "./tab-registry";

export interface TabHandle {
  handle: string;
  ltid: LogicalTabId;
}

interface HandleMap {
  handleToLtid: Map<string, LogicalTabId>;
  ltidToHandle: Map<LogicalTabId, string>;
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
  return { handleToLtid: new Map(), ltidToHandle: new Map(), counter: 1 };
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
 * handles whose ltid is in `ownedSet`. Non-owned handles (e.g. minted
 * while enumerating `listTabs` for the user's other tabs) stay in memory
 * but don't bloat chatDb across SW lifetimes.
 */
function snapshotOwned(
  map: HandleMap,
  ownedSet: Set<LogicalTabId>,
): PersistedHandleState {
  const handles: Record<string, LogicalTabId> = {};
  for (const [h, ltid] of map.handleToLtid) {
    if (ownedSet.has(ltid)) handles[h] = ltid;
  }
  return { handles, counter: map.counter };
}

function restore(state: PersistedHandleState | undefined): HandleMap {
  if (!state) return emptyMap();
  const map = emptyMap();
  for (const [h, ltid] of Object.entries(state.handles)) {
    map.handleToLtid.set(h, ltid);
    map.ltidToHandle.set(ltid, h);
  }
  // Defensive: clamp the stored counter to a finite positive integer (in
  // case chatDb was tampered with or partially written). If somehow lower
  // than the highest seen handle suffix, advance it so newly-minted
  // handles can't collide.
  let maxSeen = 0;
  for (const h of map.handleToLtid.keys()) {
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
 * ltid is in the conversation's `ownedLtids` are written; ephemeral
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
      const ownedSet = new Set<LogicalTabId>(conv?.ownedLtids ?? []);
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
 * any persisted ltid the registry can't currently resolve to a chrome tab
 * (the SW restart killed the tab). Idempotent: subsequent calls return
 * the same in-flight promise until it settles.
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

      // Prune handles whose ltid the registry can't resolve. Resolution is
      // a sync `Map.get` — far cheaper than the legacy `chrome.tabs.get`
      // round-trip per handle. An ltid resolves only when the registry
      // has either minted it in this SW lifetime (via `registerExisting`,
      // typically during `rebuildIndexesFromStorage`) or migrated it from
      // chatDb v15 at startup. Unresolvable ltids are treated as dead
      // tabs — the upstream conversation reconciliation will already
      // have removed them from `ownedLtids`.
      const ltids = Array.from(restored.ltidToHandle.keys());

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
      for (const ltid of ltids) {
        const resolvable = tabRegistry.toChromeTabId(ltid) !== undefined;
        if (!resolvable) {
          pruned = true;
          continue;
        }
        const handle = restored.ltidToHandle.get(ltid)!;
        // Only adopt the restored binding if neither side is already
        // claimed in-memory (the live map wins).
        if (live.handleToLtid.has(handle)) continue;
        if (live.ltidToHandle.has(ltid)) continue;
        live.handleToLtid.set(handle, ltid);
        live.ltidToHandle.set(ltid, handle);
      }
      live.counter = Math.max(live.counter, restored.counter);

      // If we pruned anything, write the pruned snapshot back so the
      // next cold-start doesn't re-pay the resolve work on dead ltids.
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

/**
 * Mint or retrieve the handle for a conversation+ltid pair. Returns the
 * existing handle if one is already bound; otherwise mints `t<counter>`
 * and increments. Either way, schedules a persist.
 *
 * `ltid` is the stable LogicalTabId from `tab-registry`. Tools that have a
 * raw chrome tab id should resolve it via `tabRegistry.registerExisting(ctid)`
 * (idempotent) before calling this.
 */
export function getOrCreateHandle(
  conversationId: string,
  ltid: LogicalTabId,
): string {
  const map = getMap(conversationId);
  const existing = map.ltidToHandle.get(ltid);
  if (existing) {
    // Re-persist on every access. Cheap (the coalesce in `persist()`
    // collapses N calls in a tick to 1 chatDb write) and necessary: a
    // handle minted ephemerally — e.g. by `listTabs` for a tab that was
    // not yet in `ownedLtids` — gets filtered out by `snapshotOwned()`
    // at mint time. If `selectTab` later binds that tab into the
    // conversation, we need a chance to re-snapshot so the handle lands
    // in chatDb. Without this re-persist, that ephemeral handle would
    // be lost on the next service-worker restart.
    persist(conversationId);
    return existing;
  }

  const handle = `t${map.counter++}`;
  map.handleToLtid.set(handle, ltid);
  map.ltidToHandle.set(ltid, handle);
  persist(conversationId);
  return handle;
}

export function resolveHandle(
  conversationId: string,
  handle: string,
): LogicalTabId | undefined {
  return maps.get(conversationId)?.handleToLtid.get(handle);
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
 * List the live `{handle, ltid}` pairs for a conversation. Used by the
 * system-prompt tab-legend renderer. Reads only from the in-memory map —
 * call `loadHandlesForConversation` first if you need post-restart state.
 */
export function listHandles(
  conversationId: string,
): { handle: string; ltid: LogicalTabId }[] {
  const map = maps.get(conversationId);
  if (!map) return [];
  return Array.from(map.handleToLtid, ([handle, ltid]) => ({ handle, ltid }));
}

/**
 * Drop a single handle (e.g. when its underlying tab is closed). Takes
 * the ltid, not the chrome tab id — the registry is the only place that
 * translates between them. Idempotent.
 */
export function dropLtid(ltid: LogicalTabId): void {
  for (const [conversationId, map] of maps) {
    const handle = map.ltidToHandle.get(ltid);
    if (handle) {
      map.handleToLtid.delete(handle);
      map.ltidToHandle.delete(ltid);
      persist(conversationId);
    }
  }
}

// Subscribe to the registry's onRemove event (which is the deduped stream
// — Chrome's trailing onRemoved after onReplaced is already filtered out).
// Replaces the legacy `chrome.tabs.onRemoved` listener that keyed on ctid
// directly (and silently dropped agent handles every time a Speculation
// Rules site like Attio activated a prerender).
//
// `onReplace` is intentionally not subscribed: handles key on ltid, which
// the registry does NOT change on replace. The new ctid is still
// addressable through the same ltid; nothing in the handle map needs to
// move.
tabRegistry.onRemove(({ ltid }) => {
  dropLtid(ltid);
});

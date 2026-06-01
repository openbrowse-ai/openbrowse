import { storage } from '@/lib/storage'
import type { Space } from '@/lib/types'
import { HOME_PAGE_URL } from '@/lib/constants'
import { isPrefixSubset } from './favorite-tabs'

export function generateId(): string {
  return crypto.randomUUID()
}

// ---------------------------------------------------------------------------
// Home-tab space anchor
// ---------------------------------------------------------------------------
//
// A space's window is identified durably across browser restarts (which
// reassign window ids) by stamping the space id onto the pinned home tab's
// URL: `home.html?space=<id>`. Chrome's tab restore reopens that exact URL,
// so on startup we can read each window's tabs, find the anchor, and rebind
// the window to its space. Pinned-tab overlap is the fallback when no anchor
// is present (e.g. migration from before this existed).

const HOME_BASE = chrome.runtime.getURL(HOME_PAGE_URL)

function homeUrlForSpace(spaceId: string): string {
  return `${HOME_BASE}?space=${encodeURIComponent(spaceId)}`
}

/** Extract the `?space=<id>` anchor from a tab URL, if present. */
export function spaceIdFromUrl(url: string | undefined): string | null {
  if (!url || !url.startsWith(HOME_BASE)) return null
  try {
    return new URL(url).searchParams.get('space')
  } catch {
    return null
  }
}

function isHomeUrl(url: string | undefined): boolean {
  return !!url && url.startsWith(HOME_BASE)
}

// ---------------------------------------------------------------------------
// Space creation
// ---------------------------------------------------------------------------

export async function ensureDefaultSpace(windowId: number): Promise<Space> {
  const spaces = await storage.getSpaces()

  if (spaces.length === 0) {
    const space: Space = {
      id: generateId(),
      name: 'Space 1',
      windowId,
      position: 1,
      icon: null,
      favorites: [],
      pinnedTabs: [],
      colors: null,
      colorMode: null,
    }
    await storage.setSpaces([space])
    return space
  }

  const unassigned = spaces.find((s) => s.windowId === null)
  if (unassigned) {
    await storage.updateSpace(unassigned.id, { windowId })
    return { ...unassigned, windowId }
  }

  // No unassigned space to reclaim — create a fresh one for this window.
  // (We deliberately do NOT reclaim an assigned space by position; that was
  // found to be more confusing than just creating a new space.)
  const nextPosition = Math.max(...spaces.map((s) => s.position)) + 1
  const space: Space = {
    id: generateId(),
    name: `Space ${nextPosition}`,
    windowId,
    position: nextPosition,
    icon: null,
    favorites: [],
    pinnedTabs: [],
    colors: null,
    colorMode: null,
  }
  await storage.setSpaces([...spaces, space])
  return space
}

export async function getOrCreateSpaceForWindow(windowId: number): Promise<Space> {
  const existing = await storage.getSpaceByWindowId(windowId)
  if (existing) return existing

  return ensureDefaultSpace(windowId)
}

/**
 * Ensure the window has a pinned home tab carrying the space anchor. If a
 * home tab already exists, make sure its URL has the right `?space=<id>`
 * (stamps the anchor for windows opened before this existed).
 */
async function ensureHomeTab(windowId: number, spaceId: string): Promise<void> {
  const tabs = await chrome.tabs.query({ windowId })
  const home = tabs.find((t) => isHomeUrl(t.url))
  const targetUrl = homeUrlForSpace(spaceId)

  if (home?.id != null) {
    if (spaceIdFromUrl(home.url) !== spaceId) {
      await chrome.tabs.update(home.id, { url: targetUrl })
    }
    if (!home.pinned) await chrome.tabs.update(home.id, { pinned: true })
    return
  }

  const tab = await chrome.tabs.create({
    windowId,
    url: targetUrl,
    pinned: true,
    index: 0,
    active: false,
  })
  if (tab.id) {
    await chrome.tabs.move(tab.id, { index: 0 })
  }
}

export async function focusOrCreateWindow(space: Space): Promise<void> {
  if (space.windowId !== null) {
    let windowExists = true
    try {
      await chrome.windows.update(space.windowId, { focused: true })
    } catch {
      // Window no longer exists — fall through to recreate. Only a
      // windows.update failure gates recreation.
      windowExists = false
    }
    if (windowExists) {
      // Window is live; ensure its home anchor best-effort. A tab-level
      // error here must NOT trigger recreation / storage.updateSpace.
      await ensureHomeTab(space.windowId, space.id).catch(() => {})
      return
    }
  }

  // Recreate the window with the home tab + the space's PINNED tabs. We
  // intentionally do NOT reopen favorites — favorites are saved bookmarks
  // opened on demand, not auto-opened tabs. Pinned tabs, by contrast, are
  // always-present and are what defines the window on restore.
  const homeUrl = homeUrlForSpace(space.id)
  const pinnedUrls = space.pinnedTabs ?? []
  const windowUrls = [homeUrl, ...pinnedUrls]

  const newWindow = await chrome.windows.create({
    focused: true,
    url: windowUrls,
  })

  if (!newWindow?.id) return

  await storage.updateSpace(space.id, { windowId: newWindow.id })

  if (newWindow.tabs) {
    // Pin the home tab + the recreated pinned tabs (everything we opened).
    const pinCount = 1 + pinnedUrls.length
    for (let i = 0; i < pinCount && i < newWindow.tabs.length; i++) {
      const tab = newWindow.tabs[i]
      if (tab?.id) {
        await chrome.tabs.update(tab.id, { pinned: true })
      }
    }
  }

  const allTabs = await chrome.tabs.query({ windowId: newWindow.id })
  const homeTab = allTabs.find((t) => isHomeUrl(t.url))
  if (homeTab?.id) {
    await chrome.tabs.update(homeTab.id, { active: true })
  }
}

export async function switchToSpace(position: number): Promise<void> {
  const space = await storage.getSpaceByPosition(position)
  if (!space) return
  await focusOrCreateWindow(space)
}

export async function switchToSpaceById(spaceId: string): Promise<void> {
  const spaces = await storage.getSpaces()
  const space = spaces.find((s) => s.id === spaceId)
  if (!space) return
  await focusOrCreateWindow(space)
}

export async function createSpace(name: string, icon: string | null = null): Promise<Space> {
  const spaces = await storage.getSpaces()
  const nextPosition = spaces.length > 0
    ? Math.max(...spaces.map((s) => s.position)) + 1
    : 1

  const space: Space = {
    id: generateId(),
    name,
    windowId: null,
    position: nextPosition,
    icon,
    favorites: [],
    pinnedTabs: [],
    colors: null,
    colorMode: null,
  }

  await storage.setSpaces([...spaces, space])
  return space
}

export async function renameSpace(id: string, name: string): Promise<void> {
  await storage.updateSpace(id, { name })
}

// ---------------------------------------------------------------------------
// Pinned-tab snapshotting (Part 1) — keeps Space.pinnedTabs in sync
// ---------------------------------------------------------------------------

const pinnedSnapshotTimers = new Map<number, ReturnType<typeof setTimeout>>()
const PINNED_SNAPSHOT_DEBOUNCE_MS = 300

/**
 * Debounced: snapshot a window's current pinned-tab URLs (in strip order,
 * excluding the home tab) into its bound space. Only runs for windows that
 * map to a space.
 */
export function schedulePinnedSnapshot(windowId: number): void {
  const existing = pinnedSnapshotTimers.get(windowId)
  if (existing) clearTimeout(existing)
  pinnedSnapshotTimers.set(
    windowId,
    setTimeout(() => {
      pinnedSnapshotTimers.delete(windowId)
      void snapshotPinnedTabs(windowId)
    }, PINNED_SNAPSHOT_DEBOUNCE_MS),
  )
}

async function snapshotPinnedTabs(windowId: number): Promise<void> {
  try {
    const space = await storage.getSpaceByWindowId(windowId)
    if (!space) return
    const tabs = await chrome.tabs.query({ windowId, pinned: true })
    tabs.sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
    const pinnedTabs = tabs
      .filter((t) => t.url && !isHomeUrl(t.url))
      .map((t) => t.url!)
    // No-op if unchanged.
    const same =
      pinnedTabs.length === space.pinnedTabs.length &&
      pinnedTabs.every((u, i) => u === space.pinnedTabs[i])
    if (same) return
    await storage.updateSpace(space.id, { pinnedTabs })
  } catch {
    // window/tab gone; ignore.
  }
}

// ---------------------------------------------------------------------------
// Startup reconciliation (Part 2)
// ---------------------------------------------------------------------------

/**
 * Re-bind spaces to their windows after a restart (window ids change):
 *  - Pass 1: bind each window with a `home.html?space=<id>` anchor tab.
 *  - Pass 2: for unclaimed windows, match by pinned-tab overlap against
 *    unclaimed spaces' saved `pinnedTabs` (greedy, ≥1 non-home overlap);
 *    stamp the anchor on success so future restarts use Pass 1.
 *  - Pass 3: clear `windowId` for any space not claimed by a live window.
 */
export async function reconcileSpacesWithWindows(): Promise<void> {
  let wins: chrome.windows.Window[]
  try {
    wins = await chrome.windows.getAll({ populate: true, windowTypes: ['normal'] })
  } catch {
    return
  }
  const spaces = await storage.getSpaces()
  if (spaces.length === 0) return

  const claimedSpaceIds = new Set<string>()
  const boundWindowIds = new Set<number>()
  // spaceId -> new windowId
  const newBinding = new Map<string, number>()

  // Pass 1: authoritative anchor match.
  for (const w of wins) {
    if (w.id == null) continue
    const anchorTab = w.tabs?.find((t) => spaceIdFromUrl(t.url) != null)
    const sid = anchorTab ? spaceIdFromUrl(anchorTab.url) : null
    if (sid && spaces.some((s) => s.id === sid) && !claimedSpaceIds.has(sid)) {
      newBinding.set(sid, w.id)
      claimedSpaceIds.add(sid)
      boundWindowIds.add(w.id)
    }
  }

  // Pass 2: pinned-overlap fallback for unclaimed windows.
  for (const w of wins) {
    if (w.id == null || boundWindowIds.has(w.id)) continue
    const winPinned = (w.tabs ?? [])
      .filter((t) => t.pinned && t.url && !isHomeUrl(t.url))
      .map((t) => t.url!)
    if (winPinned.length === 0) continue

    let best: Space | null = null
    let bestScore = 0
    for (const s of spaces) {
      if (claimedSpaceIds.has(s.id)) continue
      if (s.pinnedTabs.length === 0) continue
      // Only exact or path-prefix matches count toward binding. A mere
      // shared hostname is too weak — two unrelated spaces both pinning
      // e.g. github.com would otherwise cross-bind to each other's windows.
      let score = 0
      for (const pu of winPinned) {
        if (s.pinnedTabs.some((su) => su === pu || isPrefixSubset(pu, su))) {
          score++
        }
      }
      if (score > bestScore) {
        bestScore = score
        best = s
      }
    }
    if (best && bestScore >= 1) {
      newBinding.set(best.id, w.id)
      claimedSpaceIds.add(best.id)
      boundWindowIds.add(w.id)
      // Self-heal: stamp the anchor so future restarts use Pass 1.
      void ensureHomeTab(w.id, best.id).catch(() => {})
    }
  }

  // Apply bindings + clear stale windowIds.
  const updated = spaces.map((s) => {
    const bound = newBinding.get(s.id)
    if (bound != null) return { ...s, windowId: bound }
    // Not claimed by any window this pass → its stored windowId is stale
    // (the id may now belong to a different live window), so clear it.
    if (s.windowId != null) return { ...s, windowId: null }
    return s
  })
  await storage.setSpaces(updated)
}

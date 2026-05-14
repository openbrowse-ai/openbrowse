import { storage } from '@/lib/storage'
import type { Space } from '@/lib/types'
import { HOME_PAGE_URL } from '@/lib/constants'

export function generateId(): string {
  return crypto.randomUUID()
}

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

  const nextPosition = Math.max(...spaces.map((s) => s.position)) + 1
  const space: Space = {
    id: generateId(),
    name: `Space ${nextPosition}`,
    windowId,
    position: nextPosition,
    icon: null,
    favorites: [],
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

async function ensureHomeTab(windowId: number): Promise<void> {
  const homeUrl = chrome.runtime.getURL(HOME_PAGE_URL)
  const tabs = await chrome.tabs.query({ windowId })
  const hasHome = tabs.some((t) => t.url?.startsWith(homeUrl))
  if (hasHome) return

  const tab = await chrome.tabs.create({
    windowId,
    url: homeUrl,
    pinned: true,
    index: 0,
    active: false,
  })

  // Move to index 0 in case Chrome placed it after other pinned tabs
  if (tab.id) {
    await chrome.tabs.move(tab.id, { index: 0 })
  }
}

export async function focusOrCreateWindow(space: Space): Promise<void> {
  if (space.windowId !== null) {
    try {
      await chrome.windows.update(space.windowId, { focused: true })
      await ensureHomeTab(space.windowId)
      return
    } catch {
      // window no longer exists, recreate
    }
  }

  const homeUrl = chrome.runtime.getURL(HOME_PAGE_URL)
  const favoriteUrls = space.favorites.map((f) => f.url)
  const windowUrls = [homeUrl, ...favoriteUrls]

  const newWindow = await chrome.windows.create({
    focused: true,
    url: windowUrls,
  })

  if (!newWindow?.id) return

  await storage.updateSpace(space.id, { windowId: newWindow.id })

  if (newWindow.tabs) {
    const pinCount = 1 + favoriteUrls.length
    for (let i = 0; i < pinCount && i < newWindow.tabs.length; i++) {
      const tab = newWindow.tabs[i]
      if (tab?.id) {
        await chrome.tabs.update(tab.id, { pinned: true })
      }
    }
  }

  const allTabs = await chrome.tabs.query({ windowId: newWindow.id })
  const homeTab = allTabs.find((t) => t.url?.startsWith(homeUrl))
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
    colors: null,
    colorMode: null,
  }

  await storage.setSpaces([...spaces, space])
  return space
}

export async function renameSpace(id: string, name: string): Promise<void> {
  await storage.updateSpace(id, { name })
}

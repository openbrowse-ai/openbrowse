import { HOME_PAGE_URL } from '@/lib/constants'

let offscreenCreated = false

export async function ensureOffscreenDocument(): Promise<void> {
  if (offscreenCreated) return

  const existingContexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
  })

  if (existingContexts.length > 0) {
    offscreenCreated = true
    return
  }

  await chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['WORKERS'],
    justification: 'Run WebLLM for AI-powered tab management',
  })

  offscreenCreated = true
}

export async function openHomePage(windowId: number): Promise<void> {
  const homeBase = chrome.runtime.getURL(HOME_PAGE_URL)

  // Resolve (or create) this window's space so the home tab carries the
  // durable `?space=<id>` anchor. Without the anchor, a reopened home tab
  // can't identify its space if the windowId binding is ever missing, and
  // the home page falls back to the first space — the "every window shows
  // S1 after an update" bug.
  const { getOrCreateSpaceForWindow, ensureHomeTab, spaceIdFromUrl } =
    await import('./spaces')
  const space = await getOrCreateSpaceForWindow(windowId)

  // Ensure a correctly-anchored, pinned home tab exists (creates it, or
  // repairs the anchor on an existing/un-anchored home tab).
  await ensureHomeTab(windowId, space.id)

  // Activate the (now guaranteed) home tab.
  const tabs = await chrome.tabs.query({ windowId })
  const home = tabs.find(
    (t) =>
      t.url?.startsWith(homeBase) &&
      (spaceIdFromUrl(t.url) === space.id || spaceIdFromUrl(t.url) === null),
  )
  if (home?.id != null) {
    await chrome.tabs.update(home.id, { active: true })
  }
}

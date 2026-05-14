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
  const homeUrl = chrome.runtime.getURL(HOME_PAGE_URL)

  const tabs = await chrome.tabs.query({ windowId })
  const existingHome = tabs.find((t) => t.url?.startsWith(homeUrl))

  if (existingHome && existingHome.id) {
    await chrome.tabs.update(existingHome.id, { active: true })
    return
  }

  await chrome.tabs.create({
    windowId,
    url: homeUrl,
    pinned: true,
    active: true,
  })
}

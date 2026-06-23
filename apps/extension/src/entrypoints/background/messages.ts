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
  const newtabBase = chrome.runtime.getURL("/newtab.html")

  // Match a tab as "the home tab" by its committed `url` OR its
  // `pendingUrl`. On a freshly created window — exactly the case where
  // this function gets called from the auto-home onCreated listener — the
  // home tab the creator just opened may still be loading, so its `url`
  // is empty and the real URL lives in `pendingUrl`. Without checking
  // both, we'd miss the existing home tab and create a duplicate.
  const isHomeTab = (t: chrome.tabs.Tab): boolean =>
    Boolean(
      t.url?.startsWith(homeBase) || t.pendingUrl?.startsWith(homeBase),
    )

  // Only spaces that already exist for this window get the durable
  // `?space=<id>` anchor. The default install path is space-less; we never
  // lazily create a space here. Space creation only happens via explicit
  // user action on the Spaces page or the `new-space` overlay action.
  //
  // Pinning the home tab itself, however, is universal: the home tab is
  // OpenBrowse's app shell and stays pinned regardless of whether a space
  // is bound to the window.
  const { storage } = await import('@/lib/storage')
  const space = await storage.getSpaceByWindowId(windowId)

  if (space) {
    const { ensureHomeTab, spaceIdFromUrl } = await import('./spaces')
    // Ensure a correctly-anchored, pinned home tab exists (creates it, or
    // repairs the anchor on an existing/un-anchored home tab).
    await ensureHomeTab(windowId, space.id)

    // Activate the (now guaranteed) home tab.
    const tabs = await chrome.tabs.query({ windowId })
    const home = tabs.find(
      (t) =>
        isHomeTab(t) &&
        // Accept either the correctly-anchored URL or an un-anchored one
        // (which `ensureHomeTab` will have repaired). Match against both
        // `url` and `pendingUrl` for the same reason as `isHomeTab` above.
        (spaceIdFromUrl(t.url ?? t.pendingUrl ?? '') === space.id ||
          spaceIdFromUrl(t.url ?? t.pendingUrl ?? '') === null),
    )
    if (home?.id != null) {
      await chrome.tabs.update(home.id, { active: true })
    }
    return
  }

  // No space bound to this window — open / activate a pinned, un-anchored
  // home tab. The home tab is the app shell and is always pinned; only the
  // `?space=<id>` URL anchor is space-specific.
  //
  // Snapshot the window's initial tab set BEFORE we create the home tab.
  // We use this for two things:
  //   1. Reuse an existing home tab if one is already there.
  //   2. Identify the override-supplied newtab.html that Chrome opens as
  //      the initial tab on Cmd-N when chrome_url_overrides.newtab is set,
  //      so we can close it AFTER the home tab is created (Chrome closes
  //      the entire window if you remove its last tab).
  // Capturing the list before the create call ensures any Cmd-T activity
  // happening in the same tick doesn't get caught by the close loop.
  const initialTabs = await chrome.tabs.query({ windowId })
  const existing = initialTabs.find(isHomeTab)
  if (existing?.id != null) {
    if (!existing.pinned) {
      await chrome.tabs.update(existing.id, { pinned: true })
    }
    await chrome.tabs.update(existing.id, { active: true })
    return
  }
  const created = await chrome.tabs.create({
    windowId,
    url: homeBase,
    pinned: true,
    index: 0,
    active: true,
  })
  if (created.id != null) {
    // chrome.tabs.create with index: 0 is best-effort; some Chrome versions
    // ignore index when pinned tabs already exist. Force the home tab to
    // sit at the leftmost pinned position.
    await chrome.tabs.move(created.id, { index: 0 }).catch(() => {})
    // Belt-and-suspenders: re-read the tab and force `pinned: true` if the
    // initial create somehow didn't take. Observed in practice on freshly
    // created Chrome windows where `tabs.create({ pinned: true })` lands as
    // an unpinned tab. Cheap to verify, prevents a confusing UX.
    try {
      const fresh = await chrome.tabs.get(created.id)
      if (!fresh.pinned) {
        await chrome.tabs.update(created.id, { pinned: true })
      }
    } catch {
      // Tab vanished between create and verify — give up silently.
    }
  }

  // Close the override-supplied newtab.html that Chrome auto-opened with
  // the new window. The pinned home tab now exists (we just created and
  // verified it), so removing the newtab won't close the window.
  // Restrict to ids captured BEFORE the home tab was created so any
  // Cmd-T activity in this same tick is unaffected.
  //
  // Match four URL forms because Chrome reports the new-window initial
  // tab differently depending on lifecycle timing and override state:
  //   - `chrome-extension://<id>/newtab.html` in `url` (override resolved,
  //     navigation committed)
  //   - same in `pendingUrl` (override resolving, not yet committed)
  //   - `chrome://newtab/` in `url` (override disabled by user, or
  //     committed as canonical NTP URL)
  //   - `chrome://newtab/` in `pendingUrl` (the production shape on
  //     Cmd-N: `url` is empty and `pendingUrl` carries the canonical
  //     target Chrome will resolve to our newtab.html via the override)
  const isNewtabTab = (t: chrome.tabs.Tab): boolean => {
    const url = t.url ?? ""
    const pending = t.pendingUrl ?? ""
    return (
      url.startsWith(newtabBase) ||
      pending.startsWith(newtabBase) ||
      url === "chrome://newtab/" ||
      pending === "chrome://newtab/"
    )
  }
  const initialNewtabIds = initialTabs
    .filter((t) => t.id != null && isNewtabTab(t))
    .map((t) => t.id!)
  for (const id of initialNewtabIds) {
    await chrome.tabs.remove(id).catch(() => {})
  }
}

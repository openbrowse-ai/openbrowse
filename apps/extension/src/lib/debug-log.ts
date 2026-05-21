// #region DEBUG
const DEBUG_KEY_PREFIX = 'openbrowse-debug-'

function getContextName(): string {
  // @ts-ignore - ServiceWorkerGlobalScope is not available in all contexts
  if (typeof ServiceWorkerGlobalScope !== 'undefined' && typeof self !== 'undefined' && self instanceof ServiceWorkerGlobalScope) return 'bg'
  if (typeof location !== 'undefined' && location?.pathname?.includes('offscreen')) return 'off'
  return 'ui'
}

export async function debugLog(msg: string): Promise<void> {
  try {
    const key = DEBUG_KEY_PREFIX + getContextName()
    const ts = new Date().toISOString().slice(11, 23)
    const entry = `${ts} [${getContextName()}] ${msg}`
    const result = await chrome.storage.local.get(key)
    const existing: string[] = (result[key] as string[] | undefined) ?? []
    existing.push(entry)
    if (existing.length > 200) existing.splice(0, existing.length - 200)
    await chrome.storage.local.set({ [key]: existing })
  } catch {}
}

export async function getDebugLog(): Promise<string[]> {
  try {
    const keys = [DEBUG_KEY_PREFIX + 'bg', DEBUG_KEY_PREFIX + 'off', DEBUG_KEY_PREFIX + 'ui']
    const result = await chrome.storage.local.get(keys)
    const all: string[] = []
    for (const k of keys) {
      const logs = result[k] as string[] | undefined
      if (logs) all.push(...logs)
    }
    return all.sort()
  } catch {
    return []
  }
}

export async function clearDebugLog(): Promise<void> {
  try {
    const keys = [DEBUG_KEY_PREFIX + 'bg', DEBUG_KEY_PREFIX + 'off', DEBUG_KEY_PREFIX + 'ui']
    await chrome.storage.local.remove(keys)
  } catch {}
}
// #endregion DEBUG

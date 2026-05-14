// src/lib/messages.ts
import type { MessageType, SortResult } from './types'

export async function sendToOffscreen(message: MessageType): Promise<unknown> {
  return chrome.runtime.sendMessage({ target: 'offscreen', ...message })
}

export async function requestSortTabs(
  tabs: { id: string; url: string; title: string }[],
): Promise<SortResult> {
  const response = await sendToOffscreen({
    type: 'SORT_TABS',
    tabs,
  })
  return response as SortResult
}


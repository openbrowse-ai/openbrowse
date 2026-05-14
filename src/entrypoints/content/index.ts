const OVERLAY_HOST_ID = 'openbrowse-overlay-host'
const TOAST_HOST_ID = 'openbrowse-toast-host'
const AGENT_TOAST_HOST_ID = 'openbrowse-agent-toast-host'

let toastTimeout: ReturnType<typeof setTimeout> | null = null
let activeUndoHandler: (() => void) | null = null
let undoKeyHandler: ((e: KeyboardEvent) => void) | null = null

function getOrCreateToastHost() {
  let host = document.getElementById(TOAST_HOST_ID)
  if (host) return host.shadowRoot!
  host = document.createElement('div')
  host.id = TOAST_HOST_ID
  const shadow = host.attachShadow({ mode: 'open' })
  const style = document.createElement('style')
  style.textContent = `
    .sb-toast-container {
      position: fixed;
      bottom: 32px;
      left: 50%;
      transform: translateX(-50%);
      z-index: 2147483647;
      pointer-events: none;
      display: flex;
      flex-direction: column;
      align-items: center;
    }
    .sb-toast {
      pointer-events: auto;
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 10px 16px;
      border-radius: 8px;
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
      font-size: 13px;
      line-height: 1.4;
      color: #fafafa;
      background: #18181b;
      border: 1px solid rgba(255,255,255,0.08);
      box-shadow: 0 4px 12px rgba(0,0,0,0.15), 0 1px 3px rgba(0,0,0,0.1);
      animation: sb-toast-in 0.2s ease-out;
      transition: opacity 0.15s ease-out, transform 0.15s ease-out;
    }
    @media (prefers-color-scheme: light) {
      .sb-toast {
        color: #18181b;
        background: #fff;
        border: 1px solid #e4e4e7;
        box-shadow: 0 4px 12px rgba(0,0,0,0.06), 0 1px 3px rgba(0,0,0,0.04);
      }
      .sb-toast-undo { background: #18181b !important; color: #fafafa !important; }
      .sb-toast-undo:hover { opacity: 0.9 !important; }
      .sb-toast-kbd { background: rgba(0,0,0,0.08) !important; color: #71717a !important; }
    }
    .sb-toast.sb-toast-out {
      opacity: 0;
      transform: translateY(8px);
    }
    .sb-toast-undo {
      display: flex;
      align-items: center;
      gap: 6px;
      background: #fafafa;
      color: #18181b;
      border: none;
      padding: 0 8px;
      height: 24px;
      border-radius: 4px;
      font-size: 12px;
      font-weight: 500;
      cursor: pointer;
      font-family: inherit;
      line-height: 1;
      flex-shrink: 0;
      transition: opacity 0.2s;
    }
    .sb-toast-undo:hover { opacity: 0.9; }
    .sb-toast-kbd {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      height: 18px;
      min-width: 18px;
      padding: 0 5px;
      border-radius: 4px;
      background: rgba(255,255,255,0.15);
      font-size: 11px;
      font-weight: 500;
      font-family: inherit;
      line-height: 1;
      color: rgba(255,255,255,0.6);
      border: none;
    }
    @keyframes sb-toast-in {
      from { opacity: 0; transform: translateY(8px); }
      to { opacity: 1; transform: translateY(0); }
    }
  `
  const container = document.createElement('div')
  container.className = 'sb-toast-container'
  shadow.appendChild(style)
  shadow.appendChild(container)
  document.body.appendChild(host)
  return shadow
}

function performUndo(undoData: any) {
  chrome.runtime.sendMessage({ type: 'OVERLAY_UNDO', undoData }).then(() => {
    const host = document.getElementById(OVERLAY_HOST_ID)
    const iframe = host?.shadowRoot?.querySelector('iframe')
    if (iframe?.contentWindow) {
      iframe.contentWindow.postMessage({ type: 'OPENBROWSE_UNDO_COMPLETE' }, '*')
    }
  })
}

function dismissToast() {
  if (toastTimeout) { clearTimeout(toastTimeout); toastTimeout = null }
  if (undoKeyHandler) { document.removeEventListener('keydown', undoKeyHandler); undoKeyHandler = null }
  activeUndoHandler = null
  const host = document.getElementById(TOAST_HOST_ID)
  const toast = host?.shadowRoot?.querySelector('.sb-toast')
  if (toast) {
    toast.classList.add('sb-toast-out')
    setTimeout(() => toast.remove(), 150)
  }
}

function showToast(message: string, undoData?: any) {
  const shadow = getOrCreateToastHost()
  const container = shadow.querySelector('.sb-toast-container')!

  dismissToast()

  const toast = document.createElement('div')
  toast.className = 'sb-toast'

  const text = document.createElement('span')
  text.textContent = message
  toast.appendChild(text)

  if (undoData) {
    const doUndo = () => {
      performUndo(undoData)
      dismissToast()
    }
    activeUndoHandler = doUndo

    const btn = document.createElement('button')
    btn.className = 'sb-toast-undo'
    const label = document.createTextNode('Undo')
    btn.appendChild(label)
    const kbd = document.createElement('span')
    kbd.className = 'sb-toast-kbd'
    kbd.textContent = '⌘Z'
    btn.appendChild(kbd)
    btn.addEventListener('click', doUndo)
    toast.appendChild(btn)

    undoKeyHandler = (e: KeyboardEvent) => {
      if (e.key === 'z' && (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey) {
        e.preventDefault()
        doUndo()
      }
    }
    document.addEventListener('keydown', undoKeyHandler)
  }

  container.appendChild(toast)

  toastTimeout = setTimeout(() => dismissToast(), 4000)
}

function getOrCreateAgentToastHost(): ShadowRoot {
  let host = document.getElementById(AGENT_TOAST_HOST_ID)
  if (host) return host.shadowRoot!
  host = document.createElement('div')
  host.id = AGENT_TOAST_HOST_ID
  const shadow = host.attachShadow({ mode: 'open' })
  const style = document.createElement('style')
  style.textContent = `
    .ab-root {
      position: fixed;
      bottom: 20px;
      left: 50%;
      transform: translateX(-50%);
      z-index: 2147483646;
      pointer-events: none;
      display: flex;
      flex-direction: column;
      align-items: center;
    }
    .ab-pill {
      pointer-events: auto;
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 8px 10px 8px 14px;
      border-radius: 999px;
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
      font-size: 13px;
      line-height: 1.3;
      color: #18181b;
      background: #fff;
      border: 1px solid #e4e4e7;
      box-shadow: 0 4px 12px rgba(0,0,0,0.08), 0 1px 3px rgba(0,0,0,0.05);
      animation: ab-in 0.18s ease-out;
    }
    @media (prefers-color-scheme: dark) {
      .ab-pill { color: #fafafa; background: #18181b; border-color: rgba(255,255,255,0.08); }
      .ab-sep { background: rgba(255,255,255,0.1) !important; }
    }
    .ab-dot {
      width: 8px;
      height: 8px;
      border-radius: 999px;
      background: #f97316;
      flex-shrink: 0;
    }
    .ab-sep {
      width: 1px;
      height: 16px;
      background: rgba(0,0,0,0.08);
    }
    .ab-btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 26px;
      height: 26px;
      border-radius: 999px;
      border: none;
      background: transparent;
      color: inherit;
      cursor: pointer;
      padding: 0;
      opacity: 0.75;
      transition: opacity 0.15s;
    }
    .ab-btn:hover { opacity: 1; background: rgba(0,0,0,0.04); }
    @media (prefers-color-scheme: dark) {
      .ab-btn:hover { background: rgba(255,255,255,0.06); }
    }
    @keyframes ab-in {
      from { opacity: 0; transform: translateY(8px); }
      to { opacity: 1; transform: translateY(0); }
    }
  `
  const container = document.createElement('div')
  container.className = 'ab-root'
  shadow.appendChild(style)
  shadow.appendChild(container)
  document.body.appendChild(host)
  return shadow
}

function removeAgentToast() {
  document.getElementById(AGENT_TOAST_HOST_ID)?.remove()
}

function showAgentActiveToast() {
  const shadow = getOrCreateAgentToastHost()
  const container = shadow.querySelector('.ab-root')!
  if (container.querySelector('.ab-pill')) return

  const pill = document.createElement('div')
  pill.className = 'ab-pill'

  const dot = document.createElement('span')
  dot.className = 'ab-dot'
  pill.appendChild(dot)

  const label = document.createElement('span')
  label.textContent = 'Agent is active in this tab'
  pill.appendChild(label)

  const sep = document.createElement('span')
  sep.className = 'ab-sep'
  pill.appendChild(sep)

  const openBtn = document.createElement('button')
  openBtn.className = 'ab-btn'
  openBtn.title = 'Open chat'
  openBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>'
  openBtn.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'OPEN_SIDEPANEL_FROM_OVERLAY' })
  })
  pill.appendChild(openBtn)

  const dismissBtn = document.createElement('button')
  dismissBtn.className = 'ab-btn'
  dismissBtn.title = 'Dismiss'
  dismissBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>'
  dismissBtn.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'DISMISS_TOAST' })
    removeAgentToast()
  })
  pill.appendChild(dismissBtn)

  container.appendChild(pill)
}

function removeOverlay() {
  document.getElementById(OVERLAY_HOST_ID)?.remove()
  document.body.style.overflow = ''
}

function createOverlay(action?: string) {
  const host = document.createElement('div')
  host.id = OVERLAY_HOST_ID
  const shadow = host.attachShadow({ mode: 'open' })

  const style = document.createElement('style')
  style.textContent = `
    .sb-backdrop {
      position: fixed;
      inset: 0;
      z-index: 2147483647;
      background: rgba(0, 0, 0, 0.4);
      display: flex;
      align-items: flex-start;
      justify-content: center;
      padding-top: 20vh;
    }
    .sb-frame {
      width: 580px;
      max-width: 90vw;
      max-height: 70vh;
      border: none;
      border-radius: 8px;
      background: transparent;
      color-scheme: light dark;
    }
  `

  const backdrop = document.createElement('div')
  backdrop.className = 'sb-backdrop'
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) removeOverlay()
  })

  const iframe = document.createElement('iframe')
  iframe.className = 'sb-frame'
  const overlayUrl = action
    ? chrome.runtime.getURL(`/overlay.html?action=${action}`)
    : chrome.runtime.getURL('/overlay.html')
  iframe.src = overlayUrl

  backdrop.appendChild(iframe)
  shadow.appendChild(style)
  shadow.appendChild(backdrop)
  document.body.appendChild(host)
  document.body.style.overflow = 'hidden'

  iframe.addEventListener('load', () => iframe.focus())

  // Re-append toast host so it renders above the overlay
  const toastHost = document.getElementById(TOAST_HOST_ID)
  if (toastHost) document.body.appendChild(toastHost)
}

function toggleOverlay(action?: string) {
  const existing = document.getElementById(OVERLAY_HOST_ID)
  if (existing) {
    existing.remove()
  } else {
    createOverlay(action)
  }
}

export default defineContentScript({
  matches: ['<all_urls>'],
  runAt: 'document_idle',
  main() {
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (message.type === 'GET_PAGE_CONTEXT') {
        sendResponse(extractPageContext())
      }
      if (message.type === 'TOGGLE_OVERLAY') {
        toggleOverlay(message.action)
        sendResponse({ ok: true })
      }
      if (message.type === 'CHAT_EXTRACT_CONTENT') {
        sendResponse(extractDetailedContent())
      }
      if (message.type === 'CHAT_CLICK_ELEMENT') {
        try {
          const el = document.querySelector(message.selector) as HTMLElement | null
          if (!el) {
            sendResponse({ success: false, error: `Element not found: ${message.selector}` })
          } else {
            el.click()
            sendResponse({ success: true })
          }
        } catch (err) {
          sendResponse({ success: false, error: String(err) })
        }
      }
      if (message.type === 'CHAT_TYPE_IN_ELEMENT') {
        try {
          const el = document.querySelector(message.selector) as HTMLInputElement | HTMLTextAreaElement | null
          if (!el) {
            sendResponse({ success: false, error: `Element not found: ${message.selector}` })
          } else {
            el.focus()
            if (message.clearFirst) {
              el.value = ''
              el.dispatchEvent(new Event('input', { bubbles: true }))
            }
            el.value = message.text
            el.dispatchEvent(new Event('input', { bubbles: true }))
            el.dispatchEvent(new Event('change', { bubbles: true }))
            sendResponse({ success: true })
          }
        } catch (err) {
          sendResponse({ success: false, error: String(err) })
        }
      }
      if (message.type === 'OVERLAY_TOAST_STATE') {
        if (message.show) {
          showAgentActiveToast()
        } else {
          removeAgentToast()
        }
        sendResponse({ ok: true })
      }
      if (message.type === 'CHAT_SCROLL_PAGE') {
        try {
          const pixels = message.amount ?? 600
          window.scrollBy(0, message.direction === 'up' ? -pixels : pixels)
          sendResponse({ success: true })
        } catch (err) {
          sendResponse({ success: false, error: String(err) })
        }
      }
    })

    window.addEventListener('message', (e) => {
      if (e.data?.type === 'OPENBROWSE_OVERLAY_CLOSE') {
        removeOverlay()
      }
      if (e.data?.type === 'OPENBROWSE_OVERLAY_RESIZE' && typeof e.data.height === 'number') {
        const host = document.getElementById(OVERLAY_HOST_ID)
        const iframe = host?.shadowRoot?.querySelector('iframe')
        if (iframe) iframe.style.height = `${e.data.height}px`
      }
      if (e.data?.type === 'OPENBROWSE_TOAST') {
        showToast(e.data.message, e.data.undoData)
      }
      if (e.data?.type === 'OPENBROWSE_TRIGGER_UNDO') {
        if (activeUndoHandler) activeUndoHandler()
      }
    })

    document.addEventListener('keydown', (e) => {
      if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return
      const match = e.code.match(/^Digit([1-9])$/)
      if (match) {
        e.preventDefault()
        chrome.runtime.sendMessage({ type: 'SWITCH_SPACE_BY_POSITION', position: parseInt(match[1], 10) })
      }
    })

  },
})

function extractPageContext() {
  const meta = (name: string) =>
    document.querySelector<HTMLMetaElement>(`meta[name="${name}"], meta[property="${name}"]`)?.content?.trim() || ''

  const h1 = document.querySelector('h1')?.textContent?.trim().slice(0, 200) || ''

  const description = meta('description') || meta('og:description') || meta('twitter:description')

  const bodyText = document.body?.innerText?.replace(/\s+/g, ' ')?.trim().slice(0, 300) || ''

  return {
    h1,
    description: description.slice(0, 300),
    snippet: bodyText,
    type: meta('og:type'),
    siteName: meta('og:site_name'),
  }
}

function extractDetailedContent() {
  const readability = document.cloneNode(true) as Document
  const scripts = readability.querySelectorAll('script, style, noscript, svg, iframe')
  scripts.forEach((el) => el.remove())

  const body = readability.body?.innerText?.replace(/\s+/g, ' ')?.trim() || ''

  const meta = (name: string) =>
    document.querySelector<HTMLMetaElement>(`meta[name="${name}"], meta[property="${name}"]`)?.content?.trim() || ''

  const links = Array.from(document.querySelectorAll('a[href]'))
    .slice(0, 50)
    .map((a) => ({
      text: (a as HTMLAnchorElement).textContent?.trim().slice(0, 100) || '',
      href: (a as HTMLAnchorElement).href,
    }))
    .filter((l) => l.text && l.href.startsWith('http'))

  return {
    url: location.href,
    title: document.title,
    h1: document.querySelector('h1')?.textContent?.trim().slice(0, 200) || '',
    description: meta('description').slice(0, 500),
    bodyText: body.slice(0, 10000),
    links,
  }
}

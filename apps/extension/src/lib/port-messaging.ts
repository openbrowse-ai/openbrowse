let nextId = 1

export function sendPortMessage(message: Record<string, unknown>): Promise<any> {
  return new Promise((resolve, reject) => {
    const id = nextId++
    const port = chrome.runtime.connect({ name: 'settings' })

    const timeout = setTimeout(() => {
      port.disconnect()
      reject(new Error('Port message timeout'))
    }, 300_000)

    port.onMessage.addListener((response) => {
      if (response?._id === id) {
        clearTimeout(timeout)
        port.disconnect()
        resolve(response.data)
      }
    })

    port.onDisconnect.addListener(() => {
      clearTimeout(timeout)
      reject(new Error(chrome.runtime.lastError?.message || 'Port disconnected'))
    })

    port.postMessage({ _id: id, ...message })
  })
}

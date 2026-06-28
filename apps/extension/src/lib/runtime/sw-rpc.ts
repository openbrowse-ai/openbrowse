/**
 * `swRpc` — realm-aware dispatch for renderer→SW RPCs.
 *
 * Background: `chrome.runtime.sendMessage` does NOT deliver back to the
 * sender's own listeners. Under the SW-host migration, the agent loop
 * runs inside the service worker and invokes RPC helpers (skills, MCP,
 * close-tabs, bind-tabs) that historically targeted SW-side listeners.
 * Those `sendMessage` calls now leave the SW realm and find no receiver
 * → Chrome rejects with "Could not establish connection. Receiving end
 * does not exist." (and the user sees "The message port closed before
 * a response was received." in the chat UI).
 *
 * `swRpc` short-circuits in the SW realm: it invokes the SW-side
 * handler in-process via a synthetic `sendResponse` callback. In every
 * other realm (renderer, offscreen, tests) it falls back to plain
 * `chrome.runtime.sendMessage` — same wire format the SW listener
 * already implements.
 *
 * Handler shape mirrors the production pattern in
 * `entrypoints/background/{skill-messages,mcp-messages,…}.ts`:
 *   `(message, sendResponse) => boolean | void`
 *
 * The handler is loaded lazily (via the `loadHandler` factory) so the
 * caller can `await import("@/entrypoints/background/...")` only when
 * actually in the SW realm — keeps non-SW bundles free of background-
 * only code.
 */

import { isServiceWorkerContext } from "./context";

export type SwHandler<M, R> = (
  message: M,
  sendResponse: (response: R) => void,
) => boolean | void | Promise<void>;

/**
 * Dispatch an RPC to the SW-side handler.
 *
 * - In the SW realm: load `handler` and invoke it in-process. The
 *   returned Promise resolves with whatever the handler passes to
 *   `sendResponse`. If the handler never calls `sendResponse`, the
 *   Promise never resolves — callers should add their own timeout if
 *   they need a guaranteed bound. (We deliberately don't impose one
 *   here because production handlers always respond.)
 *
 * - In any other realm: invoke `chrome.runtime.sendMessage(message)`
 *   directly. The promise reflects whatever the SW listener responds
 *   with (the historical behavior).
 */
export async function swRpc<M, R>(
  message: M,
  loadHandler: () => Promise<SwHandler<M, R>>,
): Promise<R> {
  if (!isServiceWorkerContext()) {
    return (await chrome.runtime.sendMessage(message)) as R;
  }

  const handler = await loadHandler();
  return await new Promise<R>((resolve, reject) => {
    const sendResponse = (response: R): void => {
      resolve(response);
    };
    try {
      // The handler may return `true` (intent to call sendResponse
      // later), `void`/`undefined` (synchronous response already
      // dispatched), or a `Promise` (we ignore the resolution — the
      // handler is expected to call sendResponse itself, just like in
      // the chrome.runtime.onMessage contract).
      const ret = handler(message, sendResponse);
      // If the handler returned a rejected Promise, surface it. Most
      // handlers swallow their own errors and call sendResponse with an
      // error payload, so this path is the safety net.
      if (ret && typeof (ret as Promise<unknown>).then === "function") {
        (ret as Promise<unknown>).catch((err) => reject(err));
      }
    } catch (err) {
      reject(err);
    }
  });
}

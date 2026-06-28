/**
 * `executeCode` tool's sandboxed JS execution.
 *
 * Surface: `executeInSandbox(code, input?, options?) → Promise<ExecuteCodeResult>`.
 * The public signature is stable across realms — every tool and test
 * mocks `executeInSandbox` at this boundary, so the dispatch logic
 * lives inside this module rather than at each call site.
 *
 * Dispatch rules:
 *   - **Empty code** short-circuits everywhere.
 *   - **Service worker** has no DOM, so we cannot create the iframe
 *     locally. We `ensureOffscreenDocument()` and forward the request
 *     to the offscreen document via `chrome.runtime.sendMessage({
 *     target: "offscreen", type: "SANDBOX_EXECUTE", ... })`. The
 *     offscreen handler runs `executeInSandboxLocal` against its own
 *     iframe and returns the result over the same response promise.
 *   - **Offscreen / renderer** (any realm with a DOM) runs
 *     `executeInSandboxLocal` directly.
 *
 * The in-iframe protocol (host → `sandbox.html` iframe → Web Worker,
 * then result back via `window.postMessage`) is unchanged — see
 * `apps/extension/public/sandbox.html` for the worker entry. The host
 * timeout (`hostTimeoutMs`) races the sandbox's own timeout
 * (`sandboxTimeoutMs`) so the sandbox always reports first with logs.
 */

import { isServiceWorkerContext } from "@/lib/runtime/context";

export interface ExecuteCodeResult {
  result?: unknown;
  logs: string[];
  error?: string;
}

let sandboxFrame: HTMLIFrameElement | null = null;
let nextId = 1;

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;
/** Buffer added to the host-side timeout above the sandbox-side timeout so
 *  the sandbox always reports first (with logs) instead of the host racing
 *  it with a logless timeout error. */
const HOST_TIMEOUT_BUFFER_MS = 2_000;

/**
 * Public entry point. Dispatches to the appropriate realm-local
 * implementation.
 */
export async function executeInSandbox(
  code: string,
  input?: unknown,
  options?: { unboundedOutput?: boolean; timeoutMs?: number },
): Promise<ExecuteCodeResult> {
  if (!code) {
    return { error: "No code provided", logs: [] };
  }
  if (isServiceWorkerContext()) {
    return executeInSandboxViaOffscreen(code, input, options);
  }
  return executeInSandboxLocal(code, input, options);
}

/**
 * Forward the request to the offscreen document. The SW first ensures
 * the offscreen page exists (idempotent), then awaits a `sendMessage`
 * round-trip. Errors thrown by the transport surface as
 * `ExecuteCodeResult.error` so callers can keep one error-handling path.
 */
async function executeInSandboxViaOffscreen(
  code: string,
  input: unknown,
  options: { unboundedOutput?: boolean; timeoutMs?: number } | undefined,
): Promise<ExecuteCodeResult> {
  try {
    // Lazy-import the SW-only offscreen ensure helper. Pulling it
    // statically would couple `tools/sandbox.ts` (used in tests) to
    // SW-only modules.
    const { ensureOffscreenDocument } = await import(
      "@/entrypoints/background/messages"
    );
    await ensureOffscreenDocument();
    const response = (await chrome.runtime.sendMessage({
      target: "offscreen",
      type: "SANDBOX_EXECUTE",
      code,
      input,
      options: options ?? {},
    })) as ExecuteCodeResult | undefined;
    if (response == null) {
      return { error: "Offscreen returned no response", logs: [] };
    }
    return response;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { error: message, logs: [] };
  }
}

/**
 * Local iframe-driven execution. Runs in offscreen (production) and in
 * any DOM-bearing renderer (legacy/bench paths). Identical to the
 * pre-SW-host behavior.
 */
export function executeInSandboxLocal(
  code: string,
  input?: unknown,
  options?: { unboundedOutput?: boolean; timeoutMs?: number },
): Promise<ExecuteCodeResult> {
  // Clamp the requested timeout into [1ms, MAX_TIMEOUT_MS]. The Zod schema
  // upstream caps at MAX_TIMEOUT_MS too, but defensive clamping here means
  // direct callers (tests, non-tool wrappers) can't bypass the bound.
  const requestedTimeout =
    typeof options?.timeoutMs === "number" ? options.timeoutMs : DEFAULT_TIMEOUT_MS;
  const sandboxTimeoutMs = Math.min(
    Math.max(requestedTimeout, 1),
    MAX_TIMEOUT_MS,
  );
  const hostTimeoutMs = sandboxTimeoutMs + HOST_TIMEOUT_BUFFER_MS;
  return new Promise((resolve) => {
    const id = nextId++;
    const frame = ensureSandbox();
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    let resolved = false;

    const cleanup = () => {
      if (timeoutId) clearTimeout(timeoutId);
      window.removeEventListener("message", handler);
    };

    const safeResolve = (result: ExecuteCodeResult) => {
      if (resolved) return;
      resolved = true;
      cleanup();
      resolve(result);
    };

    function handler(e: MessageEvent) {
      if (e.data?.id !== id) return;
      const { result, logs, error } = e.data;
      if (error) {
        safeResolve({ error, logs: logs || [] });
      } else {
        safeResolve({ result, logs: logs || [] });
      }
    }

    window.addEventListener("message", handler);

    timeoutId = setTimeout(() => {
      safeResolve({
        error: `Execution timed out after ${sandboxTimeoutMs}ms`,
        logs: [],
      });
    }, hostTimeoutMs);

    // Wait for iframe to load if needed, then post message.
    // `unboundedOutput` suppresses the sandbox's 1 MB JSON-output cap. The
    // tool layer sets it when `saveAs` is in play — the result is going
    // straight to /workspace, never into chat context, so the cap that
    // exists to protect chat from huge tool results is counterproductive.
    const send = () => {
      frame.contentWindow?.postMessage(
        {
          id,
          code,
          input,
          unboundedOutput: !!options?.unboundedOutput,
          timeoutMs: sandboxTimeoutMs,
        },
        "*",
      );
    };

    if (frame.contentWindow && frame.getAttribute("data-ready")) {
      send();
    } else {
      frame.addEventListener("load", () => {
        frame.setAttribute("data-ready", "1");
        send();
      }, { once: true });
    }
  });
}

function ensureSandbox(): HTMLIFrameElement {
  if (sandboxFrame && sandboxFrame.parentNode) return sandboxFrame;
  sandboxFrame = document.createElement("iframe");
  sandboxFrame.src = chrome.runtime.getURL("sandbox.html");
  sandboxFrame.style.display = "none";
  document.body.appendChild(sandboxFrame);
  return sandboxFrame;
}

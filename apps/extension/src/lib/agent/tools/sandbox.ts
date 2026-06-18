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

function ensureSandbox(): HTMLIFrameElement {
  if (sandboxFrame && sandboxFrame.parentNode) return sandboxFrame;
  sandboxFrame = document.createElement("iframe");
  sandboxFrame.src = chrome.runtime.getURL("sandbox.html");
  sandboxFrame.style.display = "none";
  document.body.appendChild(sandboxFrame);
  return sandboxFrame;
}

export function executeInSandbox(
  code: string,
  input?: unknown,
  options?: { unboundedOutput?: boolean; timeoutMs?: number },
): Promise<ExecuteCodeResult> {
  if (!code) {
    return Promise.resolve({ error: "No code provided", logs: [] });
  }
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

export interface ExecuteCodeResult {
  result?: unknown;
  logs: string[];
  error?: string;
}

let sandboxFrame: HTMLIFrameElement | null = null;
let nextId = 1;

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
  options?: { unboundedOutput?: boolean },
): Promise<ExecuteCodeResult> {
  if (!code) {
    return Promise.resolve({ error: "No code provided", logs: [] });
  }
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
      safeResolve({ error: "Execution timed out after 30s", logs: [] });
    }, 32_000);

    // Wait for iframe to load if needed, then post message.
    // `unboundedOutput` suppresses the sandbox's 1 MB JSON-output cap. The
    // tool layer sets it when `saveAs` is in play — the result is going
    // straight to /workspace, never into chat context, so the cap that
    // exists to protect chat from huge tool results is counterproductive.
    const send = () => {
      frame.contentWindow?.postMessage(
        { id, code, input, unboundedOutput: !!options?.unboundedOutput },
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

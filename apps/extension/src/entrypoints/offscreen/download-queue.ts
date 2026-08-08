/**
 * Serialize + dedupe long-running local-model downloads.
 *
 * WebLLM and Gemini Nano load their weights into a single WebGPU / `chrome.ai`
 * engine per offscreen document. Two loads kicked off at once contend on that
 * engine and stall — the "stuck at 0%" symptom. This queue runs at most one
 * task at a time in FIFO order, and collapses concurrent requests for the same
 * key onto one shared in-flight promise, so a double-click (or a duplicate
 * message) can't launch the same download twice.
 *
 * A failed task never breaks the chain: the next queued task still runs.
 * Once a task settles its key is released, so a later retry starts fresh.
 */
export interface SerialQueue {
  /**
   * Enqueue `task` under `key`. If a task with the same key is already
   * in-flight (running or waiting), the existing promise is returned and
   * `task` is not invoked again.
   */
  run<T>(key: string, task: () => Promise<T>): Promise<T>;
  /** True while any task is queued or running. */
  isActive(): boolean;
}

export function createSerialQueue(): SerialQueue {
  let tail: Promise<unknown> = Promise.resolve();
  const inFlight = new Map<string, Promise<unknown>>();

  function run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const existing = inFlight.get(key) as Promise<T> | undefined;
    if (existing) return existing;

    // Chain after whatever is queued. A prior rejection must not break the
    // chain, so run `task` regardless of how the predecessor settled.
    const started = tail.then(
      () => task(),
      () => task(),
    );

    // Keep the chain non-rejecting so future links always proceed.
    tail = started.then(
      () => undefined,
      () => undefined,
    );

    inFlight.set(key, started);
    // Release the key as soon as `started` settles. Registered here (before
    // the caller awaits `started`) so it runs on the first settle microtask,
    // ahead of the caller's continuation — a subsequent run(key) after an
    // `await` therefore sees the key already cleared and starts fresh.
    const release = () => {
      if (inFlight.get(key) === started) inFlight.delete(key);
    };
    void started.then(release, release);

    return started;
  }

  function isActive(): boolean {
    return inFlight.size > 0;
  }

  return { run, isActive };
}

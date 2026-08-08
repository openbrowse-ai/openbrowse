/**
 * Serializes on-device model generation in the offscreen document.
 *
 * WebLLM (WebGPU) and Gemini Nano (`chrome.ai`) run on this document's main
 * thread and share a single engine per model. Running two generations at once
 * — e.g. the agent run (via the local-model bridge) and chat-title generation
 * firing on the same send — double-loads weights and contends on the GPU,
 * which surfaces as the UI freezing right after a message is sent.
 *
 * Every local-model generation funnels through this lock so only one holds the
 * engine at a time. It is a plain FIFO promise chain with no dependencies, so
 * it is safe to import from both `ai.ts` and the bridge handler without
 * dragging the heavy WebGPU import graph into unit tests.
 */
let chain: Promise<unknown> = Promise.resolve();

export function withLocalEngineLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn);
  // Keep the chain alive whether or not `fn` rejected, so one failed
  // generation never wedges every subsequent one.
  chain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

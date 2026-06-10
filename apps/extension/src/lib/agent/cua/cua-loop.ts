import { ToolLoopAgent, readUIMessageStream, stepCountIs } from "ai";
import type { BrowserDriver, TabId } from "../driver";
import type { CanonicalAction } from "./actions";
import { computeDisplay, readViewport } from "./coords";
import { executeCanonicalAction } from "./executor";
import { captureNormalizedShot, captureRegionShot } from "./screenshot";
import type { CuaRunConfig, CuaRunResult } from "./provider";
import { notifyAgentStatus } from "../agent-indicator";

/**
 * Plain OUTPUT value of the CUA computer tool's `execute`. Carries the
 * post-action viewport screenshot as a data URL — the SAME shape the main
 * agent's screenshot tool uses (`agent-transport.ts`), so both go through
 * an identical `toModelOutput` conversion. `execute` must NOT return the
 * AI-SDK model-output shape directly; that's `toModelOutput`'s job.
 */
export interface CuaActionOutput {
  imageDataUrl?: string;
  /** Current tab URL after the action, surfaced to the model each step. */
  currentUrl?: string;
  /** True when the post-action screenshot is byte-identical to the prior one
   *  for a state-changing action (loop-side detection; see runCuaToolLoop). */
  noChange?: boolean;
}

/**
 * Run a canonical action, then capture a viewport screenshot NORMALIZED to
 * the model's declared display dimensions (so image-pixels match the
 * coordinate space the model reasons in — see screenshot.ts). Returns the
 * plain `{ imageDataUrl }` tool OUTPUT; the provider's `toModelOutput`
 * converts it into an AI SDK image content part.
 */
export async function executeAndShoot(
  driver: BrowserDriver,
  tabId: TabId,
  action: CanonicalAction,
  displayWidth: number,
  displayHeight: number,
): Promise<CuaActionOutput> {
  // The "working on this page" overlay blocks user input via a shield + key
  // capture. The agent's own CDP input is trusted and respects the shield, so
  // we toggle passthrough ON around this action (awaited, so the shield is
  // provably down before the CDP dispatch and back up after). No-op when no
  // overlay is present.
  const needsPassthrough = INPUT_ACTION_KINDS.has(action.kind);
  if (needsPassthrough) await setShieldPassthrough(driver, tabId, true);
  try {
    await executeCanonicalAction(driver, tabId, action);
  } finally {
    if (needsPassthrough) await setShieldPassthrough(driver, tabId, false);
  }

  const imageDataUrl =
    action.kind === "zoom"
      ? await captureRegionShot(
          driver,
          tabId,
          { x1: action.x1, y1: action.y1, x2: action.x2, y2: action.y2 },
          displayWidth,
          displayHeight,
        )
      : await captureNormalizedShot(driver, tabId, displayWidth, displayHeight);
  // Surface the current URL each step so the model always knows where it is
  // (it cannot see the browser address bar). Best-effort — never fail the
  // action over a missing tab.
  const currentUrl = await driver
    .getTab(tabId)
    .then((t) => t.url)
    .catch(() => undefined);
  // Fire a transient in-page click ripple AFTER capturing the screenshot, so
  // it's visible to a human watching the live tab without ever appearing in
  // the image sent to the model. Best-effort — a ripple must never fail the
  // action. Drag ripples at its start point.
  const ripple = clickRipplePoint(action);
  if (ripple) {
    void driver
      .sendToContentScript(tabId, {
        type: "CHAT_CUA_CLICK_RIPPLE",
        x: ripple.x,
        y: ripple.y,
      })
      .catch(() => {});
  }
  return { imageDataUrl, ...(currentUrl !== undefined && { currentUrl }) };
}

/** Action kinds that dispatch CDP input and thus need the shield to pass
 *  through while they run. */
const INPUT_ACTION_KINDS = new Set<CanonicalAction["kind"]>([
  "click",
  "drag",
  "move",
  "scroll",
  "type",
  "key",
  "mouseDown",
  "mouseUp",
  "holdKey",
]);

async function setShieldPassthrough(
  driver: BrowserDriver,
  tabId: TabId,
  on: boolean,
): Promise<void> {
  try {
    await driver.sendToContentScript(tabId, {
      type: "CHAT_CUA_INPUT_PASSTHROUGH",
      on,
    });
  } catch {
    // No overlay / no content script — nothing to toggle.
  }
}

/**
 * The viewport (CSS px) point to ripple for a given action, or null when the
 * action isn't a click/drag. Coordinates on click/drag actions are already
 * CSS pixels (the executor clicks there); drag ripples at the press point.
 */
function clickRipplePoint(
  action: CanonicalAction,
): { x: number; y: number } | null {
  if (action.kind === "click") return { x: action.x, y: action.y };
  if (action.kind === "drag") return { x: action.x, y: action.y };
  return null;
}

/** Actions whose screenshots are meaningfully comparable for no-op
 *  detection. Excludes pure captures and waits. */
const STATE_CHANGING_KINDS = new Set<CanonicalAction["kind"]>([
  "click", "drag", "move", "scroll", "type", "key",
  "mouseDown", "mouseUp", "holdKey", "navigate", "goBack", "goForward",
]);

/** True when the new shot is byte-identical to the prior shot for a
 *  state-changing action — signals the action did nothing visible. */
export function detectNoChange(
  prev: string | undefined,
  curr: string | undefined,
  kind: CanonicalAction["kind"],
): boolean {
  return !!curr && curr === prev && STATE_CHANGING_KINDS.has(kind);
}

/**
 * Build a ToolLoopAgent with a single computer-use tool and run it. The
 * `build` callback constructs the provider-specific tool (Anthropic now,
 * Gemini later); its `execute` should decode the model action, call
 * `executeAndShoot`, and return the result.
 */
export async function runCuaToolLoop(
  cfg: CuaRunConfig,
  build: (args: {
    downscale: number;
    displayWidth: number;
    displayHeight: number;
    runAction: (action: CanonicalAction) => Promise<CuaActionOutput>;
  }) => { tools: Record<string, unknown>; providerOptions?: Record<string, unknown> },
): Promise<CuaRunResult> {
  const vp = await readViewport(cfg.driver, cfg.tabId);
  const display = computeDisplay({
    cssWidth: vp.cssWidth,
    cssHeight: vp.cssHeight,
    maxWidth: 1280,
  });

  let lastShot: string | undefined;
  const runAction = async (action: CanonicalAction): Promise<CuaActionOutput> => {
    return new Promise<CuaActionOutput>((resolve, reject) => {
      const onAbort = () => {
        const err = new Error("aborted");
        err.name = "AbortError";
        reject(err);
      };
      if (cfg.abortSignal?.aborted) return onAbort();
      cfg.abortSignal?.addEventListener("abort", onAbort);

      executeAndShoot(
        cfg.driver,
        cfg.tabId,
        action,
        display.displayWidth,
        display.displayHeight,
      )
        .then((out) => {
          const noChange = detectNoChange(lastShot, out.imageDataUrl, action.kind);
          if (out.imageDataUrl) lastShot = out.imageDataUrl;
          resolve({ ...out, ...(noChange && { noChange: true }) });
        })
        .catch(reject)
        .finally(() => cfg.abortSignal?.removeEventListener("abort", onAbort));
    });
  };

  // Show the "OpenBrowse is working on this page" overlay (glow border +
  // input blocker) for the duration of the run. Routes through the shared
  // indicator so it gets the same space-color tint + robust delivery as the
  // main agent. Best-effort; removed in the finally below so it never lingers
  // after completion/error/abort.
  notifyAgentStatus(true, undefined, cfg.tabId as number);

  let stepCount = 0;

  const { tools, providerOptions } = build({
    downscale: display.downscale,
    displayWidth: display.displayWidth,
    displayHeight: display.displayHeight,
    runAction,
  });

  const agent = new ToolLoopAgent({
    model: cfg.model,
    tools: tools as never,
    instructions: cfg.systemPrompt,
    ...(providerOptions && { providerOptions: providerOptions as never }),
    onStepFinish: (() => {
      stepCount += 1;
    }) as never,
    stopWhen: stepCountIs(cfg.maxSteps) as never,
  });

  try {
    const stream = await agent.stream({
      prompt: cfg.task,
      ...(cfg.abortSignal && { abortSignal: cfg.abortSignal }),
    });
    let finalText = "";
    const uiStream = readUIMessageStream({ stream: stream.toUIMessageStream() });
    for await (const msg of uiStream) {
      if (cfg.abortSignal?.aborted) {
        const err = new Error("aborted");
        err.name = "AbortError";
        throw err;
      }
      cfg.onUiMessage?.(msg);
      const parts = (msg as { parts?: Array<{ type: string; text?: string }> }).parts ?? [];
      const text = parts.filter((p) => p.type === "text").map((p) => p.text ?? "").join("");
      if (text) finalText = text;
    }
    // The step cap (`stepCountIs`) truncates the run WITHOUT throwing, so a
    // truncated run would otherwise look "completed". Detect truncation:
    // hit the cap and produced no final text.
    const truncated = stepCount >= cfg.maxSteps && finalText.length === 0;
    return {
      finalText: finalText || "(CUA run produced no final text)",
      status: truncated ? "budget-exceeded" : "completed",
    };
  } catch (err) {
    const isAbort =
      err instanceof Error && (err.name === "AbortError" || /aborted/i.test(err.message));
    if (isAbort) {
      return { finalText: "(CUA run cancelled)", status: "cancelled", errorMessage: "aborted" };
    }
    return {
      finalText: `(CUA run failed: ${err instanceof Error ? err.message : String(err)})`,
      status: "failed",
      errorMessage: err instanceof Error ? err.message : String(err),
    };
  } finally {
    // Always tear down the "working on this page" overlay so it never lingers
    // after the run ends (completion, error, or abort).
    notifyAgentStatus(false, undefined, cfg.tabId as number);
  }
}

/**
 * Convert a CuaActionOutput into AI-SDK model-facing content, shared by the
 * computer tool and the navigation tools. Prepends a text part (current URL +
 * optional no-change note) BEFORE the image — Anthropic recommends text
 * before the screenshot for better grounding.
 */
export function cuaToModelOutput({
  output,
}: {
  output: { imageDataUrl?: string; currentUrl?: string; noChange?: boolean };
}) {
  const imageDataUrl = output?.imageDataUrl;
  if (!imageDataUrl) {
    return { type: "json" as const, value: (output ?? {}) as never };
  }
  const base64 = imageDataUrl.replace(/^data:image\/png;base64,/, "");
  const lines: string[] = [];
  if (output.currentUrl) lines.push(`Current URL: ${output.currentUrl}`);
  if (output.noChange) {
    lines.push(
      "Note: the last action produced no visible change to the page. Try a different approach (a different target, scroll, navigate, or goBack).",
    );
  }
  const value: Array<Record<string, unknown>> = [];
  if (lines.length) value.push({ type: "text", text: lines.join("\n") });
  value.push({ type: "image-data", data: base64, mediaType: "image/png" });
  return { type: "content" as const, value: value as never };
}

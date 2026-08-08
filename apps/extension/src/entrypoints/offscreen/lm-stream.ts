/**
 * Offscreen-side handler for the local-model bridge.
 *
 * The SW-hosted agent loop reaches WebLLM / Gemini Nano through an
 * `offscreen-lm:<uuid>` Port (see `registry/providers/__bridge__`). This
 * module owns the offscreen end of that Port: it builds (or reuses) the real
 * `LanguageModelV3` for the requested provider — which physically runs in
 * this document against WebGPU / `chrome.ai` — drives `doStream`/`doGenerate`,
 * and streams the parts back to the SW.
 *
 * Model construction is delegated to `offscreen/ai.ts::getModelFromRegistry`
 * so we share its engine cache: a long-running run does not reload weights on
 * every request. `getModel` is injectable for tests.
 */

import {
  isLocalModelPortName,
  type LmStartMessage,
  type LocalModelGenerateResult,
  type LocalModelProviderId,
  type LocalModelRequest,
  type LocalModelResponse,
  type LocalModelStreamPart,
  type LocalModelV3,
} from "@/registry/providers/__bridge__/local-model-messages";
import { scoreCoherence } from "./coherence";
import { withLocalEngineLock } from "./engine-lock";

type GetLocalModel = (
  providerId: LocalModelProviderId,
  config: Record<string, string>,
  modelId: string,
) => Promise<LocalModelV3>;

export interface LocalModelPortDeps {
  getModel?: GetLocalModel;
}

async function defaultGetModel(
  providerId: LocalModelProviderId,
  config: Record<string, string>,
  modelId: string,
): Promise<LocalModelV3> {
  const { getModelFromRegistry } = await import("./ai");
  return (await getModelFromRegistry(
    providerId,
    config,
    modelId,
  )) as LocalModelV3;
}

/**
 * `error` stream parts may carry a live `Error` (not JSON-serializable);
 * coerce it to a message string so it survives the Port. Other parts are
 * plain data.
 */
function sanitizePart(part: LocalModelStreamPart): LocalModelStreamPart {
  const p = part as { type?: string; error?: unknown };
  if (p.type === "error") {
    const message =
      p.error instanceof Error ? p.error.message : String(p.error);
    return { type: "error", error: message } as LocalModelStreamPart;
  }
  return part;
}

/**
 * Passive coherence check on a finished WebLLM reply.
 *
 * Some WebLLM builds load fine but emit token salad on specific GPUs/drivers (a
 * known quantization + WebGPU failure mode). Rather than proactively probing
 * every model — which costs a full load per verdict — we score output the model
 * has *already* produced, which is free, and tell the user what is wrong instead
 * of leaving them to wonder whether the extension is broken.
 *
 * Scoped to `web-llm`: it is the only provider with this failure mode, and
 * scoring cloud output would be pure overhead. Fires only on a `garbled`
 * verdict; `inconclusive` (short or empty replies) stays silent.
 */
function checkOutputCoherence(providerId: string, modelId: string, text: string): void {
  if (providerId !== "web-llm") return;
  const { verdict, reasons } = scoreCoherence(text);
  if (verdict !== "garbled") return;
  try {
    chrome.runtime.sendMessage({
      type: "LOCAL_MODEL_OUTPUT_GARBLED",
      modelId,
      reasons,
    });
  } catch {
    // Best-effort UX signal; no receiver is fine.
  }
}

/** Concatenate the text a `doGenerate` result produced, for the check above. */
function textOfGenerateResult(result: LocalModelGenerateResult): string {
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (p): p is { type: "text"; text: string } =>
        (p as { type?: string })?.type === "text" &&
        typeof (p as { text?: unknown })?.text === "string",
    )
    .map((p) => p.text)
    .join("");
}

/**
 * Attach the offscreen-side protocol to a single Port. Exported for testing
 * with a fake Port; production wiring goes through
 * {@link registerLocalModelStreamListener}.
 */
export function attachLocalModelPort(
  port: chrome.runtime.Port,
  deps: LocalModelPortDeps = {},
): void {
  const getModel = deps.getModel ?? defaultGetModel;
  let abort: AbortController | null = null;
  let handling = false;

  const post = (msg: LocalModelResponse) => {
    try {
      port.postMessage(msg);
    } catch {
      // Port closed by the SW mid-flight; nothing to do.
    }
  };

  const handleStart = async (msg: LmStartMessage) => {
    if (handling) return;
    handling = true;
    abort = new AbortController();
    const signal = abort.signal;
    try {
      const model = await getModel(msg.providerId, msg.config, msg.modelId);

      // Serialize against other on-device generations (chat-title, another
      // chat's agent turn) so we never double-load or contend on the shared
      // WebGPU / Nano engine.
      await withLocalEngineLock(async () => {
        if (msg.mode === "generate") {
          const result: LocalModelGenerateResult = await model.doGenerate({
            ...msg.options,
            abortSignal: signal,
          });
          checkOutputCoherence(
            msg.providerId,
            msg.modelId,
            textOfGenerateResult(result),
          );
          post({ type: "LM_GENERATE_RESULT", result });
          return;
        }

        const { stream } = await model.doStream({
          ...msg.options,
          abortSignal: signal,
        });
        const reader = stream.getReader();
        // Accumulate assistant text purely for the coherence check below. Only
        // text deltas are collected, so tool-call payloads never enter it.
        let streamedText = "";
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            const part = value as { type?: string; delta?: unknown };
            if (part?.type === "text-delta" && typeof part.delta === "string") {
              streamedText += part.delta;
            }
            post({ type: "LM_CHUNK", part: sanitizePart(value) });
          }
        } finally {
          reader.releaseLock();
        }
        checkOutputCoherence(msg.providerId, msg.modelId, streamedText);
        post({ type: "LM_DONE" });
      });
    } catch (err) {
      post({
        type: "LM_ERROR",
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      handling = false;
    }
  };

  port.onMessage.addListener((raw: LocalModelRequest) => {
    if (raw?.type === "LM_START") {
      void handleStart(raw);
    } else if (raw?.type === "LM_CANCEL") {
      abort?.abort();
    }
  });

  port.onDisconnect.addListener(() => {
    abort?.abort();
  });
}

/**
 * Register the `chrome.runtime.onConnect` listener for local-model Ports.
 * Idempotent-safe to call once at offscreen startup.
 */
export function registerLocalModelStreamListener(
  deps: LocalModelPortDeps = {},
): void {
  chrome.runtime.onConnect.addListener((port) => {
    if (!isLocalModelPortName(port.name)) return;
    attachLocalModelPort(port, deps);
  });
}

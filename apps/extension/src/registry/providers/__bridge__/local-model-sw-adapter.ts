/**
 * Service-worker-side `LanguageModelV3` adapter for local providers.
 *
 * The SW hosts the agent loop but cannot run WebLLM (WebGPU) or Gemini Nano
 * (`chrome.ai`) — those live only in the offscreen document. This adapter is
 * a thin `LanguageModelV3` proxy: `doStream`/`doGenerate` open a long-lived
 * `offscreen-lm:<uuid>` Port, forward the (serializable) call options to the
 * offscreen `lm-stream` handler, and surface the streamed parts / generate
 * result back to the AI SDK as if the model ran locally.
 *
 * `abortSignal` cannot cross the Port, so it is bridged via an out-of-band
 * `LM_CANCEL` message; the offscreen side aborts the real generation.
 *
 * Dependencies (`connect`, `ensureOffscreen`, `randomId`) are injectable so
 * the adapter can be unit-tested against a fake Port without a browser.
 */

import { ensureOffscreenDocument } from "@/entrypoints/background/messages";
import {
  LOCAL_MODEL_PORT_PREFIX,
  type LocalModelCallOptions,
  type LocalModelGenerateResult,
  type LocalModelProviderId,
  type LocalModelResponse,
  type LocalModelStreamPart,
  type LocalModelV3,
  type SerializableCallOptions,
} from "./local-model-messages";

export interface SwAdapterDeps {
  /** Open a Port. Defaults to `chrome.runtime.connect`. */
  connect?: (connectInfo: { name: string }) => chrome.runtime.Port;
  /** Ensure the offscreen document exists before connecting. */
  ensureOffscreen?: () => Promise<void>;
  /** Per-request id generator. Defaults to `crypto.randomUUID`. */
  randomId?: () => string;
}

/** Strip the non-serializable `abortSignal` before sending over the Port. */
function toSerializable(
  options: LocalModelCallOptions,
): SerializableCallOptions {
  const { abortSignal: _abortSignal, ...rest } = options;
  return rest;
}

/**
 * `chrome.runtime` Port serialization does not always preserve `Date`
 * instances (JSON turns them into strings). Revive the `response-metadata`
 * timestamp the AI SDK expects to be a real `Date`.
 */
function revivePart(part: LocalModelStreamPart): LocalModelStreamPart {
  const p = part as { type?: string; timestamp?: unknown };
  if (p.type === "response-metadata" && typeof p.timestamp === "string") {
    return {
      ...(part as object),
      timestamp: new Date(p.timestamp),
    } as LocalModelStreamPart;
  }
  return part;
}

function reviveGenerate(
  result: LocalModelGenerateResult,
): LocalModelGenerateResult {
  const ts = result.response?.timestamp as unknown;
  if (typeof ts === "string") {
    return {
      ...result,
      response: { ...result.response, timestamp: new Date(ts) },
    } as LocalModelGenerateResult;
  }
  return result;
}

function abortError(signal: AbortSignal): unknown {
  return (
    signal.reason ??
    new DOMException("The operation was aborted.", "AbortError")
  );
}

export function createLocalModelSwAdapter(
  providerId: LocalModelProviderId,
  config: Record<string, string>,
  modelId: string,
  deps: SwAdapterDeps = {},
): LocalModelV3 {
  const connect = deps.connect ?? ((info) => chrome.runtime.connect(info));
  const ensureOffscreen = deps.ensureOffscreen ?? ensureOffscreenDocument;
  const randomId = deps.randomId ?? (() => crypto.randomUUID());

  const openPort = async (): Promise<chrome.runtime.Port> => {
    await ensureOffscreen();
    return connect({ name: `${LOCAL_MODEL_PORT_PREFIX}${randomId()}` });
  };

  const model: LocalModelV3 = {
    specificationVersion: "v3",
    provider: providerId,
    modelId,
    // Local models never fetch remote URLs; nothing is natively supported.
    supportedUrls: {},

    async doStream(options: LocalModelCallOptions) {
      const port = await openPort();
      const abortSignal = options.abortSignal;

      const stream = new ReadableStream<LocalModelStreamPart>({
        start(controller) {
          let closed = false;

          const cleanup = () => {
            try {
              port.onMessage.removeListener(onMessage);
            } catch {
              /* noop */
            }
            try {
              port.onDisconnect.removeListener(onDisconnect);
            } catch {
              /* noop */
            }
            try {
              port.disconnect();
            } catch {
              /* noop */
            }
          };

          const onMessage = (msg: LocalModelResponse) => {
            if (closed) return;
            if (msg.type === "LM_CHUNK") {
              controller.enqueue(revivePart(msg.part));
            } else if (msg.type === "LM_DONE") {
              closed = true;
              controller.close();
              cleanup();
            } else if (msg.type === "LM_ERROR") {
              closed = true;
              controller.error(new Error(msg.message));
              cleanup();
            }
          };

          const onDisconnect = () => {
            if (closed) return;
            closed = true;
            try {
              controller.error(
                new Error("Offscreen local-model port disconnected"),
              );
            } catch {
              /* already errored */
            }
          };

          port.onMessage.addListener(onMessage);
          port.onDisconnect.addListener(onDisconnect);

          const onAbort = () => {
            try {
              port.postMessage({ type: "LM_CANCEL" });
            } catch {
              /* port already gone */
            }
            if (!closed) {
              closed = true;
              try {
                controller.error(abortError(abortSignal!));
              } catch {
                /* already errored */
              }
            }
            cleanup();
          };

          if (abortSignal) {
            if (abortSignal.aborted) {
              onAbort();
              return;
            }
            abortSignal.addEventListener("abort", onAbort, { once: true });
          }

          port.postMessage({
            type: "LM_START",
            mode: "stream",
            providerId,
            config,
            modelId,
            options: toSerializable(options),
          });
        },
        cancel() {
          try {
            port.postMessage({ type: "LM_CANCEL" });
          } catch {
            /* noop */
          }
          try {
            port.disconnect();
          } catch {
            /* noop */
          }
        },
      });

      return { stream };
    },

    async doGenerate(options: LocalModelCallOptions) {
      const port = await openPort();
      const abortSignal = options.abortSignal;

      return await new Promise<LocalModelGenerateResult>((resolve, reject) => {
        let settled = false;

        const cleanup = () => {
          try {
            port.onMessage.removeListener(onMessage);
          } catch {
            /* noop */
          }
          try {
            port.onDisconnect.removeListener(onDisconnect);
          } catch {
            /* noop */
          }
          try {
            port.disconnect();
          } catch {
            /* noop */
          }
        };

        const onMessage = (msg: LocalModelResponse) => {
          if (settled) return;
          if (msg.type === "LM_GENERATE_RESULT") {
            settled = true;
            resolve(reviveGenerate(msg.result));
            cleanup();
          } else if (msg.type === "LM_ERROR") {
            settled = true;
            reject(new Error(msg.message));
            cleanup();
          }
        };

        const onDisconnect = () => {
          if (settled) return;
          settled = true;
          reject(new Error("Offscreen local-model port disconnected"));
        };

        port.onMessage.addListener(onMessage);
        port.onDisconnect.addListener(onDisconnect);

        const onAbort = () => {
          try {
            port.postMessage({ type: "LM_CANCEL" });
          } catch {
            /* noop */
          }
          if (!settled) {
            settled = true;
            reject(abortError(abortSignal!));
          }
          cleanup();
        };

        if (abortSignal) {
          if (abortSignal.aborted) {
            onAbort();
            return;
          }
          abortSignal.addEventListener("abort", onAbort, { once: true });
        }

        port.postMessage({
          type: "LM_START",
          mode: "generate",
          providerId,
          config,
          modelId,
          options: toSerializable(options),
        });
      });
    },
  };

  return model;
}

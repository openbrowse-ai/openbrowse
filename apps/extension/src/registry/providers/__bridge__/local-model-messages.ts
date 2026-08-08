/**
 * Wire protocol for the local-model bridge (`web-llm` / `browser-ai`).
 *
 * The agent loop is hosted in the service worker, which has neither WebGPU
 * (WebLLM) nor `chrome.ai` (Gemini Nano). Both live only in the offscreen
 * document. This module defines the messages exchanged over a long-lived
 * `chrome.runtime` Port so the SW-side `LanguageModelV3` adapter can drive a
 * real model that physically runs in offscreen:
 *
 *   SW adapter  ──LM_START──▶  offscreen `lm-stream` handler
 *               ◀─LM_CHUNK──   (streaming tokens / tool-call deltas)
 *               ◀─LM_DONE───   (stream finished)
 *               ◀─LM_GENERATE_RESULT (non-streaming doGenerate)
 *               ◀─LM_ERROR──   (build or inference failure)
 *   SW adapter  ──LM_CANCEL─▶  (abort in-flight generation)
 *
 * The types the AI SDK uses for `doStream`/`doGenerate` (`LanguageModelV3*`)
 * are not part of `ai`'s public export surface and `@ai-sdk/provider` is not
 * a direct dependency, so we derive exactly the shapes we need structurally
 * from the public `LanguageModel` union. This keeps the bridge correct across
 * AI SDK minor bumps without importing internal type names.
 */

import type { LanguageModel } from "ai";

/** Providers whose inference must run in the offscreen document. */
export type LocalModelProviderId = "web-llm" | "browser-ai";

/** Port-name prefix; the suffix is a per-request UUID. */
export const LOCAL_MODEL_PORT_PREFIX = "offscreen-lm:";

/**
 * The concrete `LanguageModelV3` object from the public `LanguageModel`
 * union (which is `string | LanguageModelV3 | LanguageModelV2`). Selecting on
 * the spec-version discriminant yields the v3 model shape without importing
 * the non-exported `LanguageModelV3` name.
 */
export type LocalModelV3 = Extract<
  LanguageModel,
  { specificationVersion: "v3" }
>;

/** Full call options accepted by `doStream`/`doGenerate`. */
export type LocalModelCallOptions = Parameters<LocalModelV3["doStream"]>[0];

/**
 * Call options minus the parts that cannot cross a `chrome.runtime` Port.
 * `abortSignal` is a live object handled out-of-band via `LM_CANCEL`.
 */
export type SerializableCallOptions = Omit<
  LocalModelCallOptions,
  "abortSignal"
>;

type StreamResult = Awaited<ReturnType<LocalModelV3["doStream"]>>;

/** A single streamed part (`text-delta`, `tool-call`, `finish`, ...). */
export type LocalModelStreamPart =
  StreamResult["stream"] extends ReadableStream<infer P> ? P : never;

/** The result of a non-streaming `doGenerate` call. */
export type LocalModelGenerateResult = Awaited<
  ReturnType<LocalModelV3["doGenerate"]>
>;

// ── SW → offscreen ──────────────────────────────────────────────────────

export interface LmStartMessage {
  type: "LM_START";
  /** `"stream"` drives `doStream`; `"generate"` drives `doGenerate`. */
  mode: "stream" | "generate";
  providerId: LocalModelProviderId;
  config: Record<string, string>;
  modelId: string;
  options: SerializableCallOptions;
}

export interface LmCancelMessage {
  type: "LM_CANCEL";
}

export type LocalModelRequest = LmStartMessage | LmCancelMessage;

// ── offscreen → SW ──────────────────────────────────────────────────────

export interface LmChunkMessage {
  type: "LM_CHUNK";
  part: LocalModelStreamPart;
}

export interface LmDoneMessage {
  type: "LM_DONE";
}

export interface LmGenerateResultMessage {
  type: "LM_GENERATE_RESULT";
  result: LocalModelGenerateResult;
}

export interface LmErrorMessage {
  type: "LM_ERROR";
  message: string;
}

export type LocalModelResponse =
  | LmChunkMessage
  | LmDoneMessage
  | LmGenerateResultMessage
  | LmErrorMessage;

export function isLocalModelPortName(name: string): boolean {
  return name.startsWith(LOCAL_MODEL_PORT_PREFIX);
}

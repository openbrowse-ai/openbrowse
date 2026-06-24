/**
 * Shared converters between AI SDK `UIMessage` parts and the
 * `SerializedUIPart` shape we persist in chat-db.
 *
 * Extracted from `useAgentChat.ts` so the subagent runner can persist
 * subagent transcripts under their child conversation id using the
 * same encoding the parent's chat uses. Single source of truth for
 * what a "saved" message looks like.
 *
 * If you add a new `SerializedUIPart` variant, update both `serializeParts`
 * (forward conversion from SDK parts) and `hasMeaningfulContent`
 * (predicate that decides whether a streamed turn is worth saving).
 *
 * Tool-input shape contract: every persisted tool part's `input` MUST be
 * a JSON object (or `undefined`). A non-object `input` (e.g. `""` from
 * Opus's no-arg-tool quirk) is rejected by Anthropic with
 * `tool_use.input: Input should be a valid dictionary` and silently
 * coerced by Gemini — so persisting it would re-poison every subsequent
 * Anthropic send. The `normalizeToolInputForPersistence` runs the same
 * recovery ladder as the transport's send-time normalizer (parse
 * stringified JSON, fall back to rawInput) before persisting; if the
 * value is still irrecoverable, the entire tool part is dropped from
 * the saved parts array. The transport's send-time pass would have
 * dropped it too, but doing it here keeps chat-db clean.
 */

import type { UIMessage } from "ai";
import type { AgentDataParts, SerializedUIPart } from "./message-types";
import { normalizeToolInputForPersistence } from "./tool-input-normalize";

type AgentMessageParts = UIMessage<unknown, AgentDataParts>["parts"];

/**
 * Persistence-time tool-input sanitizer. Returns:
 *   - `keep-undefined` when the input was never assigned (truly absent —
 *     the SDK and runtime normalizer both tolerate this on terminal
 *     states, and the user sees an "Interrupted" badge in the UI),
 *   - `object` with a recovered plain-object value (input was already
 *     an object, or rawInput / a stringified-JSON input parsed to one),
 *   - `drop` when the input was present-and-malformed and no recovery
 *     was possible. The whole tool part must be dropped from
 *     persistence — saving it would re-poison every subsequent send.
 */
function sanitizeToolInputForPersistence(
  input: unknown,
  rawInput: unknown,
):
  | { kind: "object"; value: Record<string, unknown> }
  | { kind: "keep-undefined" }
  | { kind: "drop" } {
  // Truly absent: persist with input:undefined; the runtime normalizer at
  // send time will decide whether to drop the part (no rescue available)
  // or coerce to {} (tool accepts empty object). Keeping the persisted
  // copy lets the UI render the part as "Interrupted" until the user's
  // next send.
  if (input === undefined && rawInput === undefined) {
    return { kind: "keep-undefined" };
  }
  const result = normalizeToolInputForPersistence({
    value: input,
    rawValue: rawInput,
  });
  if (result.kind === "object") {
    return { kind: "object", value: result.value };
  }
  return { kind: "drop" };
}

/**
 * Convert AI SDK `UIMessage.parts` into the `SerializedUIPart[]` shape
 * stored in chat-db. Drops any parts the chat UI cannot render (returns
 * an empty array for unknown variants — preserves forward-compat).
 */
export function serializeParts(parts: AgentMessageParts): SerializedUIPart[] {
  return parts.flatMap((part): SerializedUIPart[] => {
    switch (part.type) {
      case "text":
        return [{ type: "text", text: part.text }];
      case "reasoning":
        return [{ type: "reasoning", text: part.text }];
      case "file":
        return [{ type: "file", mediaType: part.mediaType, url: part.url }];
      case "source-url":
        return [
          {
            type: "source-url",
            sourceId: part.sourceId,
            url: part.url,
            title: part.title,
          },
        ];
      case "step-start":
        return [{ type: "step-start" }];
      case "data-compaction":
        // `part.data` is `CompactionData` thanks to AgentDataParts.
        return [{ type: "data-compaction", data: part.data }];
      case "data-completion-check-rejection":
        // Persist completion-check rejection blocks so users see the
        // concerns again after a reload. Without this case, the chunk
        // is silently dropped at serialize time and the conversation
        // looks like the gate never ran.
        return [{ type: "data-completion-check-rejection", data: part.data }];
      case "data-plan-extension":
        // Round-trip plan-extension markers so the inline notice
        // ("Plan extended: <origin>" / "Plan extended: network access
        // permitted") survives reload. Like `data-compaction`, this is
        // a synthetic user-role marker that's stripped before reaching
        // the LLM (see `rewriteForLLM`).
        return [{ type: "data-plan-extension", data: part.data }];
      case "data-completion-check-running":
        // Strip running indicators at serialize time. They're a live-
        // stream concern only:
        //  - "evaluating" entries shouldn't survive reload — saved
        //    means the stream is over forever, but a persisted
        //    "evaluating" part would semantically lie about that
        //    state.
        //  - "done" entries render nothing in the UI (the spinner is
        //    gone; rejected/force-emitted are surfaced by the
        //    sibling rejection block; approved/skipped are silent).
        //    Persisting them would be dead weight in chatDb.
        //
        // The runtime UI guard (`isStreaming` check in
        // CompletionCheckRunningBlock) handles in-memory mid-stream
        // aborts; we never need this part on disk.
        return [];
      case "dynamic-tool": {
        // Sanitize input before persistence: a non-object value (Opus
        // emits `""` for no-arg tool calls) would re-poison every
        // subsequent send if persisted verbatim. The recovery ladder
        // matches the transport's runtime normalizer.
        const rawInput =
          "rawInput" in part
            ? (part as { rawInput?: unknown }).rawInput
            : undefined;
        const sanitized = sanitizeToolInputForPersistence(
          part.input,
          rawInput,
        );
        if (sanitized.kind === "drop") {
          // Present-but-malformed input that we cannot recover. Drop
          // the entire tool part rather than persist a value the
          // provider would reject on the next send.
          if (typeof console !== "undefined" && console.warn) {
            console.warn(
              `[serialize-parts] dropping dynamic-tool part with ` +
                `unrecoverable non-object input ` +
                `(toolName=${part.toolName}, state=${part.state}); ` +
                `see tool-input-normalize.ts.`,
            );
          }
          return [];
        }
        return [
          {
            type: "dynamic-tool",
            toolName: part.toolName,
            toolCallId: part.toolCallId,
            state: part.state,
            input: sanitized.kind === "object" ? sanitized.value : undefined,
            output: "output" in part ? part.output : undefined,
            errorText: "errorText" in part ? part.errorText : undefined,
            approval: "approval" in part ? part.approval : undefined,
          },
        ];
      }
      default: {
        const p = part as Record<string, unknown>;
        if (
          typeof part.type === "string" &&
          part.type.startsWith("tool-") &&
          "toolCallId" in p &&
          "state" in p
        ) {
          // Same input-sanitization contract as the dynamic-tool branch
          // above. The fallback path is hit by the SDK's `tool-<name>`
          // shape (built-in browser tools) — a non-object input here is
          // just as fatal at send time as in the dynamic-tool case.
          //
          // Note: we do NOT gate on `"input" in p`. A tool-<name> part
          // can legitimately reach this branch with no input field set
          // (e.g. an aborted call mid input-streaming). The sanitizer
          // returns `keep-undefined` for that case, matching the
          // dynamic-tool branch above; gating on `"input" in p` here
          // would silently drop those parts and lose the "Interrupted"
          // UI badge.
          const rawInput = "rawInput" in p ? p.rawInput : undefined;
          const sanitized = sanitizeToolInputForPersistence(p.input, rawInput);
          if (sanitized.kind === "drop") {
            if (typeof console !== "undefined" && console.warn) {
              console.warn(
                `[serialize-parts] dropping ${part.type} part with ` +
                  `unrecoverable non-object input ` +
                  `(state=${p.state as string}); see ` +
                  `tool-input-normalize.ts.`,
              );
            }
            return [];
          }
          return [
            {
              type: "dynamic-tool",
              toolName: part.type.slice(5),
              toolCallId: p.toolCallId as string,
              state: p.state as string,
              input:
                sanitized.kind === "object" ? sanitized.value : undefined,
              output: "output" in p ? p.output : undefined,
              errorText: "errorText" in p ? (p.errorText as string) : undefined,
              // Preserve approval metadata on the round-trip so a part
              // serialized via this fallback path doesn't lose its
              // approval id/state. Mirrors the explicit `dynamic-tool`
              // branch above.
              approval:
                "approval" in p
                  ? (p.approval as {
                      id: string;
                      approved?: boolean;
                      reason?: string;
                    })
                  : undefined,
            },
          ];
        }
        return [];
      }
    }
  });
}

/** Concatenate the text portions of `parts` into a single string. */
export function extractTextContent(parts: SerializedUIPart[]): string {
  return parts
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join("");
}

/**
 * Whether `parts` represents a turn worth persisting / showing.
 *
 * The AI SDK's `onFinish` callback fires for every terminal state — including
 * errors that hit before the model produced any content. In that path
 * `parts` ends up empty (or just a `step-start` marker). Saving such a
 * message to chatDb would leave a bare regenerate-icon bubble in the
 * conversation after a refresh.
 *
 * Returning false here from `onFinish` skips the save; on conversation
 * load, a trailing message that fails this predicate is also self-
 * healed out of chatDb so previously-broken chats recover automatically.
 */
export function hasMeaningfulContent(parts: SerializedUIPart[]): boolean {
  return parts.some((p) => {
    if (p.type === "text" || p.type === "reasoning") return p.text.length > 0;
    if (p.type === "dynamic-tool") return true;
    if (p.type === "file" || p.type === "source-url") return true;
    // Persisted completion-check rejection blocks must be considered
    // meaningful — the serializer goes out of its way to round-trip
    // them (see the `data-completion-check-rejection` branch in
    // `serializeParts`). Without this case, a turn whose only saved
    // content is a rejection would be dropped by the `onFinish`
    // save gate, contradicting the persist-on-purpose contract.
    if (p.type === "data-completion-check-rejection") return true;
    // Plan-extension markers are synthetic user messages whose only
    // content is the marker part — they must count as meaningful so
    // the inline "Plan extended: …" notice is preserved across reload.
    if (p.type === "data-plan-extension") return true;
    // step-start and data-compaction are markers, not user-visible content.
    return false;
  });
}

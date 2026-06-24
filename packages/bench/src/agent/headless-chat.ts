import type { TokenLimits } from "@agent/compaction";
import type { AgentUIMessage } from "@agent/message-types";
import { normalizeToolInputForPersistence } from "@agent/tool-input-normalize";
import type { UIMessageChunk } from "ai";
import type { ChatTransport, LanguageModel } from "ai";
import { runCompaction } from "./run-compaction";

/**
 * The bench harness consumes the transport's UIMessage stream manually
 * (mirroring what the real chat hook does in the extension). Tool-call
 * chunks land here as either `tool-call` or `tool-call-delta` with an
 * `args` field carrying the input. We pass that input through the same
 * persistence-side normalizer the extension uses on its serialize/
 * deserialize boundary so a non-object value never lands in the bench's
 * accumulated assistant message — which would then 400 the provider on
 * the next turn or skew the bench's eval results.
 *
 * Returns the recovered object, or `{}` if the input couldn't be
 * recovered. Coercing to {} matches the runtime transport's last-mile
 * assertion behavior; the bench is non-interactive so we prefer
 * "complete the run with a flagged eval" over "abort the trial".
 */
function normalizeBenchToolArgs(args: unknown): Record<string, unknown> {
  if (args !== null && typeof args === "object" && !Array.isArray(args)) {
    return args as Record<string, unknown>;
  }
  const result = normalizeToolInputForPersistence({ value: args });
  if (result.kind === "object") return result.value;
  // Last-resort coercion. The bench reports each trial's tool calls as
  // part of its eval output; an empty {} for an irrecoverable input is
  // visible in the report so the trial author can investigate.
  if (typeof console !== "undefined" && console.warn) {
    console.warn(
      `[bench/headless-chat] tool-call had non-object input ` +
        `(typeof=${typeof args}); coercing to {}.`,
    );
  }
  return {};
}

export async function consumeChatStream(
  transport: ChatTransport<AgentUIMessage>,
  messages: AgentUIMessage[],
  abortSignal?: AbortSignal
): Promise<AgentUIMessage> {
  const stream = await transport.sendMessages({ 
    messages, 
    abortSignal,
    trigger: "submit-message",
    chatId: "bench-chat",
    messageId: undefined
  });
  const reader = stream.getReader();
  
  const assistantMessage: AgentUIMessage = {
    id: crypto.randomUUID(),
    role: "assistant",
    parts: [],
  } as AgentUIMessage;

  while (true) {
    const { done, value: typedValue } = await reader.read();
    if (done) break;
    if (!typedValue) continue;
    
    const value: any = typedValue;
    
    // value is UIMessageChunk
    if (value.type === "text-start") {
      assistantMessage.parts.push({ type: "text", text: "" });
    } else if (value.type === "text-delta" || value.type === "text") {
      let textPart = [...assistantMessage.parts].reverse().find((p: any) => p.type === "text") as { type: "text", text: string } | undefined;
      if (!textPart) {
        textPart = { type: "text", text: "" };
        assistantMessage.parts.push(textPart);
      }
      textPart.text += value.textDelta || value.delta || value.text || "";
    } else if (value.type === "reasoning-start") {
      assistantMessage.parts.push({ type: "reasoning", text: "" });
    } else if (value.type === "reasoning" || value.type === "reasoning-delta") {
      let reasoningPart = [...assistantMessage.parts].reverse().find((p: any) => p.type === "reasoning") as { type: "reasoning", text: string } | undefined;
      if (!reasoningPart) {
        reasoningPart = { type: "reasoning", text: "" };
        assistantMessage.parts.push(reasoningPart);
      }
      reasoningPart.text += value.textDelta || value.delta || value.text || "";
    } else if (value.type === "tool-call" || value.type === "tool-call-delta") {
      if (value.toolName) {
        assistantMessage.parts.push({
          type: "dynamic-tool",
          toolName: value.toolName,
          toolCallId: value.toolCallId,
          state: "call-pending" as any,
          input: normalizeBenchToolArgs(value.args),
        } as any);
      }
    } else if (value.type === "tool-result") {
      const part = assistantMessage.parts.find((p: any) => p.type === "dynamic-tool" && p.toolCallId === value.toolCallId);
      if (part && part.type === "dynamic-tool") {
        part.state = "output-available" as any;
        part.output = value.result;
        if (value.isError) {
          part.errorText = String(value.result);
        }
      }
    } else if (value.type === "error") {
      throw new Error(`AI Stream Error: ${value.error}`);
    }
  }

  return assistantMessage;
}

export async function runHeadlessChatLoop(
  transport: ChatTransport<AgentUIMessage>,
  model: LanguageModel,
  modelInfo: TokenLimits | undefined,
  initialPrompt: string,
  getNeedsMidStreamCompaction: () => boolean,
  abortSignal?: AbortSignal,
  onCompaction?: (tokens: number) => void
): Promise<{ messages: AgentUIMessage[]; finalText: string }> {
  let messages: AgentUIMessage[] = [
    {
      id: crypto.randomUUID(),
      role: "user",
      parts: [{ type: "text", text: initialPrompt }],
    } as AgentUIMessage
  ];

  while (true) {
    if (abortSignal?.aborted) {
      break;
    }

    const assistantMessage = await consumeChatStream(transport, messages, abortSignal);
    messages = [...messages, assistantMessage];

    if (getNeedsMidStreamCompaction()) {
      const { newMessages, summaryTokens } = await runCompaction(messages, model, modelInfo);
      messages = newMessages;
      onCompaction?.(summaryTokens);
      continue;
    }

    // If the transport stream finished and we don't need compaction, the agent loop 
    // is fully complete (either task done, or max steps hit).
    break;
  }

  // Extract final text from the *last* text part
  const lastAssoc = messages[messages.length - 1];
  let finalText = "";
  if (lastAssoc && lastAssoc.role === "assistant") {
    const textParts = lastAssoc.parts.filter(p => p.type === "text") as { type: "text", text: string }[];
    const lastTextPart = textParts[textParts.length - 1];
    if (lastTextPart && "text" in lastTextPart) {
      finalText = lastTextPart.text;
    }
  }

  return { messages, finalText };
}

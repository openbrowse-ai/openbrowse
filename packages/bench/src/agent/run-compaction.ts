import {
  prepareMessagesForSummarization,
  getCompactionSystemPrompt,
  buildCompactionPrompt,
} from "@agent/compaction";
import type { TokenLimits, PrunableMessage } from "@agent/compaction";
import type { AgentUIMessage } from "@agent/message-types";
import { generateText, type LanguageModel } from "ai";

export async function runCompaction(
  messages: AgentUIMessage[],
  model: LanguageModel,
  modelInfo: TokenLimits | undefined
): Promise<{ newMessages: AgentUIMessage[]; summaryTokens: number }> {
  // In a real headless setup we'd pass the actual prune/selectTail logic here
  // But for the bench we can just summarize the messages that were passed in.
  // The exact logic of what gets passed to summarization is usually handled by `selectTail` etc.
  
  // Wait, let's copy the exact logic from useAgentChat.ts for selecting what to summarize.
  const { pruneMessages, selectTail, prepareMessagesForSummarization, buildCompactionPrompt, getCompactionSystemPrompt } = await import("@agent/compaction");
  
  // Transform to PrunableMessage
  const prunableMessages: PrunableMessage[] = messages.map(m => ({
    id: m.id,
    role: m.role as any,
    parts: m.parts as any,
    createdAt: (m as any).createdAt ?? Date.now(),
  }));

  const { pruned } = pruneMessages(prunableMessages);
  const { headMessages, tailStartId } = selectTail(pruned, modelInfo);
  if (!tailStartId || headMessages.length === 0) return { newMessages: messages, summaryTokens: 0 };
  
  const conversationText = prepareMessagesForSummarization(headMessages);
  
  // Find previous summary if any (from events, but since we have messages we can find the last summary message)
  const { findCompactionEvents } = await import("@agent/compaction");
  const events = findCompactionEvents(messages);
  const previousSummary = events.at(-1)?.summaryText;

  const userPrompt = buildCompactionPrompt(previousSummary);

  const { text: summaryText, usage } = await generateText({
    model,
    system: getCompactionSystemPrompt(),
    prompt: conversationText + "\n\n" + userPrompt,
  });

  const now = Date.now();
  
  // Create the compaction user message
  const compactionUserMessage = {
    id: crypto.randomUUID(),
    role: "user",
    parts: [
      {
        type: "data-compaction",
        data: {
          auto: true,
          tailStartMessageId: tailStartId,
        },
      },
    ],
    createdAt: now,
  } as any as AgentUIMessage;

  // Create the summary assistant message
  const summaryAssistantMessage = {
    id: crypto.randomUUID(),
    role: "assistant",
    parts: [{ type: "text", text: summaryText }],
    createdAt: now + 1,
    summary: true,
  } as any as AgentUIMessage;
  
  const tailIdx = tailStartId ? messages.findIndex(m => m.id === tailStartId) : messages.length;
  const tailMessages = tailIdx >= 0 ? messages.slice(tailIdx) : [];

  const autoContinueMessage = {
    id: crypto.randomUUID(),
    role: "user",
    parts: [{ type: "text", text: "Please continue your work." }],
    createdAt: now + 2,
  } as any as AgentUIMessage;

  return {
    newMessages: [
      ...headMessages as any as AgentUIMessage[],
      compactionUserMessage,
      summaryAssistantMessage,
      ...tailMessages as any as AgentUIMessage[],
      autoContinueMessage
    ],
    summaryTokens: (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0),
  };
}

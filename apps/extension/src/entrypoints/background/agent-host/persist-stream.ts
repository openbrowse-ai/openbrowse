/**
 * Incremental assistant-message persistence for the SW agent host.
 *
 * Consumes the same `AgentUIMessage` stream the renderer's `onFinish` used
 * to receive (one growing-by-id message per turn, plus possibly multiple
 * distinct assistant messages across a multi-step turn) and writes each
 * to chat-db via the existing `chatDb` interface.
 *
 * Lifts the persistence half of `useAgentChat.ts:497-528` (the empty-turn
 * skip, the `saveMessage` upsert, the `updateConversation` updatedAt
 * bump) into the SW host so it runs even when no renderer is open.
 *
 * Implementation detail: this module accepts a small `port` interface
 * rather than importing `chatDb` directly so tests can drive it without
 * the IndexedDB shim. The default factory in
 * `createAssistantStreamPersisterDefault` binds to the real chat-db.
 */

import { chatDb } from "@/lib/chat-db";
import type { AgentUIMessage } from "@/lib/agent/message-types";
import {
  extractTextContent,
  hasMeaningfulContent,
  serializeParts,
} from "@/lib/agent/serialize-parts";
import type { SerializedAssistantMessage } from "@/lib/agent/subagents/types";

/**
 * Minimal chat-db facade used by the persister. Lets tests substitute a
 * fake without dragging IndexedDB into the test environment.
 */
export interface AssistantStreamPersisterPort {
  saveMessage(msg: {
    id: string;
    conversationId: string;
    role: "user" | "assistant";
    content: string;
    parts: ReturnType<typeof serializeParts>;
    createdAt: number;
  }): Promise<void>;
  updateConversation(
    id: string,
    patch: { updatedAt?: number },
  ): Promise<void>;
}

export interface AssistantStreamFinal {
  finalText: string;
  messageCount: number;
  transcript: SerializedAssistantMessage[];
}

export interface AssistantStreamPersister {
  persist(message: AgentUIMessage): Promise<void>;
  final(): AssistantStreamFinal;
}

export function createAssistantStreamPersister(
  conversationId: string,
  port: AssistantStreamPersisterPort,
): AssistantStreamPersister {
  const transcriptIndexById = new Map<string, number>();
  const transcript: SerializedAssistantMessage[] = [];
  const createdAtById = new Map<string, number>();
  let lastText = "";

  return {
    async persist(message: AgentUIMessage): Promise<void> {
      if (message.role !== "assistant") return;

      const parts = serializeParts(message.parts);
      if (!hasMeaningfulContent(parts)) return;

      const text = extractTextContent(parts);

      let createdAt = createdAtById.get(message.id);
      if (createdAt === undefined) {
        createdAt = Date.now();
        createdAtById.set(message.id, createdAt);
      }

      const existingIdx = transcriptIndexById.get(message.id);
      if (existingIdx === undefined) {
        transcriptIndexById.set(message.id, transcript.length);
        transcript.push({ id: message.id, parts });
      } else {
        transcript[existingIdx] = { id: message.id, parts };
      }

      await port.saveMessage({
        id: message.id,
        conversationId,
        role: "assistant",
        content: text,
        parts,
        createdAt,
      });
      await port.updateConversation(conversationId, {
        updatedAt: Date.now(),
      });

      lastText = text;
    },

    final(): AssistantStreamFinal {
      return {
        finalText: lastText,
        messageCount: transcriptIndexById.size,
        transcript,
      };
    },
  };
}

/**
 * Default production binding to the real chat-db.
 */
export function createAssistantStreamPersisterDefault(
  conversationId: string,
): AssistantStreamPersister {
  return createAssistantStreamPersister(conversationId, {
    saveMessage: (msg) => chatDb.saveMessage(msg),
    updateConversation: (id, patch) => chatDb.updateConversation(id, patch),
  });
}

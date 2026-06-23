/**
 * Helpers for the lifecycle of child conversations spawned by subagents
 * with `peer` or `incognito` isolation.
 *
 * Inline isolation does NOT use these — it runs inside the parent's
 * conversation row.
 *
 * Naming: "child conversation" rather than "subagent conversation"
 * because the row is a normal `Conversation` with extra lineage fields
 * (`parentConversationId`, `subagentSlug`, etc.). This keeps the rest
 * of the chat data model uniform.
 */

import { chatDb } from "../../chat-db";
import type { IsolationProfile, SubagentStatus } from "./types";

/**
 * Create a child conversation row in `running` state. The caller is
 * responsible for invoking `finalizeChildConversation` when the run
 * finishes (or fails / is cancelled).
 *
 * The child inherits the parent's `spaceId` so the side panel renders
 * it in the same space as the parent.
 */
export async function createChildConversation(args: {
  parentConversationId: string;
  slug: string;
  isolation: IsolationProfile;
  title: string;
  /** Override for `incognito` runs which detach from any space. */
  spaceId?: string | null;
  /** Stamped on the row when known; mainly for `incognito`. */
  ephemeralWindowId?: number;
  /**
   * The parent's `delegate` tool call id that spawned this child.
   * Stored on the row so the parent's heal path (and the SW startup
   * reconciliation) can locate this specific child by toolCallId
   * without scanning all running children.
   */
  parentToolCallId?: string;
}): Promise<{ id: string; spaceId: string | null }> {
  const parent = await chatDb.getConversation(args.parentConversationId);
  if (!parent) {
    throw new Error(
      `createChildConversation: parent ${args.parentConversationId} not found`,
    );
  }

  const id = generateChildId();
  const now = Date.now();
  const spaceId = args.spaceId !== undefined ? args.spaceId : parent.spaceId;

  await chatDb.createConversation({
    id,
    title: args.title,
    spaceId,
    createdAt: now,
    updatedAt: now,
    parentConversationId: args.parentConversationId,
    subagentSlug: args.slug,
    subagentStatus: "running",
    isolationProfile: args.isolation,
    ...(args.ephemeralWindowId !== undefined && {
      ephemeralWindowId: args.ephemeralWindowId,
    }),
    ...(args.parentToolCallId !== undefined && {
      parentToolCallId: args.parentToolCallId,
    }),
  });

  return { id, spaceId };
}

/**
 * Mark a child conversation as finished and persist the final text.
 * Idempotent — a second call with the same status/finalText is a no-op.
 */
export async function finalizeChildConversation(args: {
  childConversationId: string;
  status: Exclude<SubagentStatus, "running">;
  finalText: string;
}): Promise<void> {
  await chatDb.updateConversation(args.childConversationId, {
    subagentStatus: args.status,
    subagentFinalText: args.finalText,
    updatedAt: Date.now(),
  });
}

function generateChildId(): string {
  // Same shape as user-rooted conversations elsewhere: timestamped + random.
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 10);
  return `subagent-${ts}-${rand}`;
}

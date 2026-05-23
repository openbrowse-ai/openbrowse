import { OPFS } from "@/lib/vfs/opfs";
import { chatDb } from "@/lib/chat-db";
import { getImageSizeLimit } from "@/lib/agent/vision-limits";
import type { Attachment } from "./types";

export interface FormattedAttachments {
  /** Text block to append to the user's message. Empty string if none. */
  block: string;
  /** Vision file-parts to send alongside the user message text. */
  visionFiles: { mediaType: string; url: string }[];
}

/**
 * Materialize `attachments` into the conversation's OPFS workspace and
 * produce the message-side decoration (text block + vision parts).
 *
 * Behavior:
 *  - Each attachment is written under `conversations/<id>/workspace/`,
 *    using `OPFS.uniquePath` to avoid clobbering existing files.
 *  - The `<Attached files>` block lists the resulting paths only — no
 *    instructions, no sizes (per design).
 *  - For image attachments, a vision file-part is added IFF the file
 *    size ≤ the active provider's image cap (`getImageSizeLimit`). Above
 *    the cap the file still lands in the workspace; the model just
 *    can't "see" it inline.
 */
export async function formatAttachments(
  conversationId: string,
  attachments: Attachment[],
  modelKey: string,
): Promise<FormattedAttachments> {
  if (attachments.length === 0) {
    return { block: "", visionFiles: [] };
  }

  const workspaceDir = `conversations/${conversationId}/workspace`;
  const imageCap = getImageSizeLimit(modelKey);

  const lines: string[] = [];
  const visionFiles: { mediaType: string; url: string }[] = [];
  /** Workspace-relative basenames (no leading slash) the working folder
   *  rail uses to filter uploads out of the agent-created file list. */
  const uploadedRelPaths: string[] = [];

  for (const att of attachments) {
    const dest = await OPFS.uniquePath(workspaceDir, att.file.name);
    await OPFS.writeFileBytes(dest, att.file);

    // Agent paths are workspace-relative.
    const basename = dest.slice(dest.lastIndexOf("/") + 1);
    const relPath = `/${basename}`;
    lines.push(`- ${relPath}`);
    uploadedRelPaths.push(basename);

    if (att.kind === "image" && att.file.size <= imageCap) {
      visionFiles.push({ mediaType: att.file.type, url: att.dataUrl });
    }
  }

  // Persist the upload list on the conversation so the Working Folder
  // rail can filter user uploads out of the agent-created file listing.
  // Append rather than overwrite — earlier uploads stay tracked. Wrapped
  // in best-effort: if chatDb is unavailable (e.g. in unit tests, or a
  // transient IndexedDB hiccup), the attachment still works — the
  // tracking is the only thing skipped.
  if (uploadedRelPaths.length > 0) {
    try {
      const conv = await chatDb.getConversation(conversationId);
      const existing = conv?.uploadedFiles ?? [];
      const next = Array.from(new Set([...existing, ...uploadedRelPaths]));
      await chatDb.updateConversation(conversationId, { uploadedFiles: next });
    } catch (err) {
      console.warn(
        "[formatAttachments] failed to record upload list",
        err,
      );
    }
  }

  return {
    block: `\n\n<Attached files>\n${lines.join("\n")}\n</Attached files>`,
    visionFiles,
  };
}

import { OPFS } from "@/lib/vfs/opfs";
import { getImageSizeLimit } from "@/lib/agent/vision-limits";
import { UPLOADS_DIR } from "@/lib/uploads-dir";
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
 *  - Each attachment is written under
 *    `conversations/<id>/workspace/.uploads/`, using `OPFS.uniquePath`
 *    to avoid clobbering existing files.
 *  - The `<Attached files>` block lists workspace-relative paths
 *    (e.g. `/.uploads/report.pdf`). The agent reads them via its `fs`
 *    tool but cannot write back — see `apps/extension/src/lib/agent/tools/fs.ts`.
 *  - For image attachments, a vision file-part is added IFF the file
 *    size ≤ the active provider's image cap (`getImageSizeLimit`).
 *    Above the cap the file still lands in the workspace; the model
 *    just can't "see" it inline.
 */
export async function formatAttachments(
  conversationId: string,
  attachments: Attachment[],
  modelKey: string,
): Promise<FormattedAttachments> {
  if (attachments.length === 0) {
    return { block: "", visionFiles: [] };
  }

  const uploadsDir = `conversations/${conversationId}/workspace/${UPLOADS_DIR}`;
  const imageCap = getImageSizeLimit(modelKey);

  const lines: string[] = [];
  const visionFiles: { mediaType: string; url: string }[] = [];

  for (const att of attachments) {
    const dest = await OPFS.uniquePath(uploadsDir, att.file.name);
    await OPFS.writeFileBytes(dest, att.file);

    // The model sees the workspace-relative path with leading slash.
    const basename = dest.slice(dest.lastIndexOf("/") + 1);
    const relPath = `/${UPLOADS_DIR}/${basename}`;
    lines.push(`- ${relPath}`);

    if (att.kind === "image" && att.file.size <= imageCap) {
      visionFiles.push({ mediaType: att.file.type, url: att.dataUrl });
    }
  }

  return {
    block: `\n\n<Attached files>\n${lines.join("\n")}\n</Attached files>`,
    visionFiles,
  };
}

/**
 * File download helpers — blob-URL + anchor-click pattern.
 *
 * No `chrome.downloads` permission required. All downloads go through the
 * default browser download flow (saves to the user's Downloads folder, or
 * triggers the Save As dialog depending on Chrome settings).
 */

import { OPFS } from "@/lib/vfs/opfs";

/** Trigger a save dialog for an in-memory blob. */
export function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  triggerDownload(url, fileName);
  // Defer revocation to next tick so the navigation has a chance to start.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** Trigger a save dialog for a string of text. */
export function downloadText(
  text: string,
  fileName: string,
  mime = "text/plain;charset=utf-8",
): void {
  downloadBlob(new Blob([text], { type: mime }), fileName);
}

/**
 * Read a file from the per-conversation OPFS workspace and trigger a save
 * dialog. The fileName argument controls the filename suggested in the save
 * dialog; pass the basename, not the full OPFS path.
 */
export async function downloadOpfsFile(
  path: string,
  fileName: string,
): Promise<void> {
  const blob = await OPFS.readFileBytes(path);
  downloadBlob(blob, fileName);
}

function triggerDownload(href: string, fileName: string): void {
  const a = document.createElement("a");
  a.href = href;
  a.download = fileName;
  a.rel = "noopener";
  // Append + click + remove keeps Firefox/Safari happy; Chrome works without
  // appending but the cost is negligible.
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/**
 * Shared file validation for drag-and-drop / picker uploads.
 *
 * Centralizes the size + count caps used in two places:
 *  - `ChatInput.addFiles` for chat-message attachments (per-provider image
 *    cap, generic file cap, lifetime count cap across the message).
 *  - `SpaceFilesSection` for files dropped into a space's workspace
 *    (per-drop count cap, generic file cap; no provider-specific image cap
 *    because these files aren't sent inline to a model).
 *
 * Returning rejection strings (rather than throwing) lets the caller surface
 * them with the toast style and copy that already exists in each surface.
 */
const MB = 1024 * 1024;

export const DEFAULT_FILE_CAP = 50 * MB;
export const DEFAULT_IMAGE_CAP = 10 * MB;
export const DEFAULT_COUNT_CAP = 10;

export type FileValidationOptions = {
  /** Max bytes for non-image files. Defaults to 50 MB. */
  fileCap?: number;
  /**
   * Max bytes for image/* files. Defaults to 10 MB. Pass the same value as
   * `fileCap` when image-specific limits don't apply (e.g. space files).
   */
  imageCap?: number;
  /** Total number of files allowed. Defaults to 10. */
  countCap?: number;
  /** How many slots are already used (e.g. existing attachments). */
  existingCount?: number;
};

export type FileValidationResult = {
  accepted: File[];
  /** Human-readable rejection messages, ready to feed into `toast.error`. */
  rejections: string[];
};

export function validateFiles(
  incoming: File[],
  opts: FileValidationOptions = {},
): FileValidationResult {
  const fileCap = opts.fileCap ?? DEFAULT_FILE_CAP;
  const imageCap = opts.imageCap ?? DEFAULT_IMAGE_CAP;
  const countCap = opts.countCap ?? DEFAULT_COUNT_CAP;
  const existingCount = opts.existingCount ?? 0;

  const rejections: string[] = [];

  const remainingSlots = Math.max(0, countCap - existingCount);
  if (incoming.length > remainingSlots) {
    if (remainingSlots === 0) {
      rejections.push(`Maximum of ${countCap} files reached.`);
    } else {
      rejections.push(
        `Only ${remainingSlots} more file${remainingSlots === 1 ? "" : "s"} allowed (max ${countCap}).`,
      );
    }
  }

  const slice = incoming.slice(0, remainingSlots);
  const accepted: File[] = [];
  for (const file of slice) {
    const isImage = file.type.startsWith("image/");
    const cap = isImage ? imageCap : fileCap;
    if (file.size > cap) {
      const capMB = Math.round(cap / MB);
      rejections.push(
        `${file.name} exceeds the ${capMB} MB ${isImage ? "image" : "file"} limit.`,
      );
      continue;
    }
    accepted.push(file);
  }

  return { accepted, rejections };
}

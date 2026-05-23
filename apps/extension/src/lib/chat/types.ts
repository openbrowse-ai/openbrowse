/**
 * A user-attached file in the chat input. Image attachments carry a
 * pre-computed data URL for the existing vision-part flow; non-image
 * files carry only the underlying `File`.
 */
export type Attachment =
  | { kind: "image"; id: string; file: File; dataUrl: string }
  | { kind: "file"; id: string; file: File };

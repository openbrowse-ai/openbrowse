/**
 * A user-attached file in the chat input. Image attachments carry a
 * pre-computed data URL for the existing vision-part flow; non-image
 * files carry only the underlying `File` plus optional metadata
 * (line count for text files) used by the preview card.
 *
 * `loading` is true between the moment the user picks/drops the file
 * and the moment its async metadata (data URL for images, line count
 * for text files) finishes computing. The chip renders a skeleton
 * placeholder during this window so picking a file gives instant
 * visual feedback.
 */
export type Attachment =
  | {
      kind: "image";
      id: string;
      file: File;
      dataUrl: string;
      loading?: boolean;
    }
  | {
      kind: "file";
      id: string;
      file: File;
      lineCount?: number;
      loading?: boolean;
    };

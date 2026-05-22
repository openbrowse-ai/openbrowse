/**
 * Filename-extension classifier shared by file viewers and binary helpers.
 *
 * OPFS preserves no MIME metadata, so the file extension is the only cheap
 * signal we have. The classes are coarse on purpose: each maps to a single
 * render branch in the viewers.
 */

export type FileClass = "markdown" | "image" | "pdf" | "binary" | "code";

const IMAGE_RE = /\.(png|jpe?g|gif|webp|avif|svg|bmp|ico)$/i;
const PDF_RE = /\.pdf$/i;
const MARKDOWN_RE = /\.(md|mdx)$/i;
// Files we know are binary but have no inline preview today.
const BINARY_RE =
  /\.(zip|tar|gz|tgz|bz2|7z|rar|wasm|exe|dll|so|dylib|bin|mp3|mp4|mov|wav|ogg|flac|webm|woff2?|ttf|otf|eot|class|jar|psd|sketch|fig|db|sqlite|sqlite3|parquet|arrow|xlsx|xlsm|xls|docx|doc|pptx|ppt)$/i;

export function classifyFile(fileName: string): FileClass {
  if (MARKDOWN_RE.test(fileName)) return "markdown";
  if (IMAGE_RE.test(fileName)) return "image";
  if (PDF_RE.test(fileName)) return "pdf";
  if (BINARY_RE.test(fileName)) return "binary";
  return "code";
}

/** True when this class needs a Blob (and a blob: URL) instead of a string. */
export function isBinaryClass(cls: FileClass): boolean {
  return cls === "image" || cls === "pdf" || cls === "binary";
}

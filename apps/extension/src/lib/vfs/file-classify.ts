/**
 * Filename-extension classifier shared by file viewers and binary helpers.
 *
 * OPFS preserves no MIME metadata, so the file extension is the only cheap
 * signal we have. The classes are coarse on purpose: each maps to a single
 * render branch in the viewers.
 */

export type FileClass =
  | "markdown"
  | "image"
  | "pdf"
  | "sheet"
  | "json"
  | "html"
  | "audio"
  | "video"
  | "binary"
  | "code";

const MARKDOWN_RE = /\.(md|mdx)$/i;
const IMAGE_RE = /\.(png|jpe?g|gif|webp|avif|svg|bmp|ico)$/i;
const PDF_RE = /\.pdf$/i;
const SHEET_RE = /\.(csv|tsv|xlsx|xlsm|xls)$/i;
const JSON_RE = /\.(json|jsonl|ndjson)$/i;
const HTML_RE = /\.html?$/i;
const AUDIO_RE = /\.(mp3|wav|ogg|flac|m4a)$/i;
const VIDEO_RE = /\.(mp4|mov|webm|mkv)$/i;
// Files we know are binary but have no inline preview today. Spreadsheet,
// audio, video, and HTML extensions are intentionally excluded — they have
// dedicated render branches above.
const BINARY_RE =
  /\.(zip|tar|gz|tgz|bz2|7z|rar|wasm|exe|dll|so|dylib|bin|woff2?|ttf|otf|eot|class|jar|psd|sketch|fig|db|sqlite|sqlite3|parquet|arrow|docx|doc|pptx|ppt)$/i;

export function classifyFile(fileName: string): FileClass {
  if (MARKDOWN_RE.test(fileName)) return "markdown";
  if (IMAGE_RE.test(fileName)) return "image";
  if (PDF_RE.test(fileName)) return "pdf";
  if (SHEET_RE.test(fileName)) return "sheet";
  if (JSON_RE.test(fileName)) return "json";
  if (HTML_RE.test(fileName)) return "html";
  if (AUDIO_RE.test(fileName)) return "audio";
  if (VIDEO_RE.test(fileName)) return "video";
  if (BINARY_RE.test(fileName)) return "binary";
  return "code";
}

/**
 * True when this class needs a Blob (and a blob: URL) instead of a string.
 *
 * `sheet` is included because `.xlsx` is binary; the SheetViewer reads `.csv`
 * via `await blob.text()` so a single load path serves all spreadsheet types.
 */
export function isBinaryClass(cls: FileClass): boolean {
  return (
    cls === "image" ||
    cls === "pdf" ||
    cls === "sheet" ||
    cls === "audio" ||
    cls === "video" ||
    cls === "binary"
  );
}

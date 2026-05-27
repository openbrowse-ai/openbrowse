/**
 * Compression for full-trace blobs uploaded to R2.
 *
 * Defaults to zstd (better ratio + speed than gzip for JSON-heavy data).
 * Node 22.15+ ships zstd in core `node:zlib`, so no native dependency is
 * needed. Gzip is supported as an explicit override (used as a portable
 * fallback if zstd is unavailable in some future runtime).
 */

import {
  zstdCompressSync,
  zstdDecompressSync,
  gzipSync,
  gunzipSync,
} from "node:zlib";

export type CompressionAlgo = "zstd" | "gzip";

export interface CompressOptions {
  /** Force a specific algo. Default: zstd. */
  algo?: CompressionAlgo;
}

export interface CompressedBlob {
  algo: CompressionAlgo;
  data: Buffer;
}

/** Compress a buffer. Defaults to zstd. */
export function compress(input: Buffer, opts: CompressOptions = {}): CompressedBlob {
  const algo: CompressionAlgo = opts.algo ?? "zstd";
  switch (algo) {
    case "zstd":
      return { algo, data: zstdCompressSync(input) };
    case "gzip":
      return { algo, data: gzipSync(input) };
    default:
      throw new Error(`unknown compression algo: ${algo as string}`);
  }
}

/** Decompress a buffer using the given algo. */
export function decompress(data: Buffer, algo: CompressionAlgo): Buffer {
  switch (algo) {
    case "zstd":
      return zstdDecompressSync(data);
    case "gzip":
      return gunzipSync(data);
    default:
      throw new Error(`unknown compression algo: ${algo as string}`);
  }
}

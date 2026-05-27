/**
 * Compression for full-trace blobs uploaded to R2.
 *
 * Defaults to zstd (better ratio + speed than gzip for JSON-heavy data).
 * The package's `engines.node` is pinned at >=22.15 so the named zstd
 * exports below are guaranteed to exist. Gzip is supported as an
 * explicit override when callers want maximum portability for blobs
 * consumed outside this package.
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

import { randomBytes } from "node:crypto";

const MAX_BYTES_PER_ARTIFACT = 25 * 1024 * 1024;
const TTL_MS = 24 * 60 * 60 * 1000;

export interface ArtifactEntry {
  id: string;
  ownerClientId: string;
  contentType: string;
  bytes: Buffer;
  filename?: string;
  createdAt: number;
}

export interface ArtifactStore {
  put(input: Omit<ArtifactEntry, "id" | "createdAt">): string;
  get(id: string): ArtifactEntry | undefined;
  sweep(): void;
  /** Total bytes currently held — exposed for observability/tests. */
  totalBytes(): number;
}

export function createArtifactStore(): ArtifactStore {
  const map = new Map<string, ArtifactEntry>();

  return {
    put(input) {
      if (input.bytes.length > MAX_BYTES_PER_ARTIFACT) {
        throw new Error(
          `artifact too large: ${input.bytes.length} bytes exceeds 25 MiB cap`,
        );
      }
      const id = randomBytes(16).toString("base64url");
      const entry: ArtifactEntry = { ...input, id, createdAt: Date.now() };
      map.set(id, entry);
      return id;
    },
    get(id) {
      const entry = map.get(id);
      if (!entry) return undefined;
      if (Date.now() - entry.createdAt > TTL_MS) {
        map.delete(id);
        return undefined;
      }
      return entry;
    },
    sweep() {
      const now = Date.now();
      for (const [id, entry] of map.entries()) {
        if (now - entry.createdAt > TTL_MS) map.delete(id);
      }
    },
    totalBytes() {
      let total = 0;
      for (const entry of map.values()) total += entry.bytes.length;
      return total;
    },
  };
}

// src/lib/memory/sync/local-tree.ts
//
// The local side of sync: the OPFS `memory/**` tree.
//
// Every mutation follows the same three-step sequence the fs tools already use
// (`syncMemoryIndex` in `lib/agent/tools/fs.ts`): write the file, reindex the
// path, then re-emit `vfs:change`. The second emit matters because `OPFS.*`
// emits *before* the index row is current, so a surface rendering parsed
// frontmatter would otherwise paint the previous row. Subscribers debounce, so
// the two emits coalesce into one refresh.

import { emitVfsChange } from "../../vfs/events";
import { OPFS } from "../../vfs/opfs";
import { memoryDirPath } from "../format";
import { memoryStore } from "../store";
import { byteLength, sha256 } from "./hash";
import { isSyncableLocalPath } from "./paths";
import type { FileEntry, LocalTreePort } from "./types";

/** Root of the global memory tree — the only scope v1 syncs. */
const GLOBAL_MEMORY_DIR = memoryDirPath(null);

/**
 * `LocalTreePort` over OPFS.
 *
 * `list()` reads and hashes every file. The memory tree is markdown notes —
 * tens to low hundreds of KB in practice — so a full rehash per pass is cheap
 * and keeps the port stateless. If that ever stops being true, the fix is an
 * mtime+size memo, not a weaker hash.
 */
export function createOpfsMemoryTree(): LocalTreePort {
  return {
    async list(): Promise<FileEntry[]> {
      const out: FileEntry[] = [];
      for await (const path of OPFS.walk(GLOBAL_MEMORY_DIR)) {
        // Skips non-markdown entries, dotfiles, and the `.tmp-<rand>` files
        // `writeFileAtomic` leaves behind on a failed write.
        if (!isSyncableLocalPath(path)) continue;
        try {
          const file = await OPFS.readFileBytes(path);
          const content = await file.text();
          out.push({
            path,
            sha256: await sha256(content),
            size: byteLength(content),
            updated: file.lastModified,
          });
        } catch {
          // Unreadable file: leave it out of this pass rather than fail the
          // whole sync. It stays on disk and gets picked up once readable.
        }
      }
      return out;
    },

    async read(path: string): Promise<string> {
      assertSyncable(path);
      return OPFS.readFile(path);
    },

    async write(path: string, content: string): Promise<void> {
      assertSyncable(path);
      await OPFS.writeFileAtomic(path, content);
      await reindex(path);
    },

    async remove(path: string): Promise<void> {
      assertSyncable(path);
      // Removes the file, its index row, and its link edges.
      await memoryStore.deleteById(path);
      emitVfsChange(path);
    },
  };
}

/**
 * Defense in depth. `engine.ts` already validates every path before it reaches
 * the port, but this is the last line before a write lands in OPFS, and the
 * cost of being wrong here is writing attacker-chosen bytes to an
 * attacker-chosen path.
 */
function assertSyncable(path: string): void {
  if (!isSyncableLocalPath(path)) {
    throw new Error(`memory sync: refusing to touch non-memory path ${path}`);
  }
}

async function reindex(path: string): Promise<void> {
  try {
    await memoryStore.syncPath(path);
    emitVfsChange(path);
  } catch {
    // The file is the source of truth; a failed index update is repaired by the
    // next `reconcile()`.
  }
}

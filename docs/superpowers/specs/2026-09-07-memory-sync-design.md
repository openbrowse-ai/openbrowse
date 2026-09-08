# Memory Sync Across Chrome Profiles — Design

**Status:** Approved design, not yet implemented
**Date:** 2026-09-07
**Scope:** Global memory (`memory/**`) only. Space-scoped memory is explicitly out of scope for v1.

## Problem

Agent memory lives in OPFS — `memory/**` for global notes, `spaces/<spaceId>/memory/**`
for space-scoped ones — with a rebuildable IndexedDB index (`memoryIndexDb`) derived
from those files. OPFS is partitioned per Chrome profile and Chrome never replicates it.

So a user who keeps separate Work and Personal Chrome profiles has two disjoint agents.
Everything the agent learned about them in one profile is invisible in the other, and
there is no way to carry it over short of retelling it.

We want opt-in sync of global memory across a user's profiles, without introducing a
server, an account, or a change to the memory file format.

## Non-goals

- **Space-scoped memory.** `Space.id` is an opaque per-profile UUID with no portable key
  (`apps/extension/src/lib/types.ts`), so `spaces/<spaceId>/memory/**` cannot be matched
  across profiles without either name-guessing (which would silently merge two unrelated
  spaces) or a new `Space.syncKey` plus a pairing UI. Deferred to a follow-up.
- **Conversations, skills, settings, API keys.** Memory only.
- **A hosted sync service.** OpenBrowse is local-first and BYOK; no server is introduced.
- **Real-time sync.** Sync is a checkpoint operation, not a live channel (see Trigger model).
- **Encryption at rest.** The vault is plaintext markdown on the user's disk, by design —
  that is what makes it inspectable and Obsidian/git-compatible. Documented, not hidden.

## Chosen approach: a shared folder the user picks in each profile

The user picks one real directory (the **vault**) in each profile via
`showDirectoryPicker()`. Each profile syncs its `memory/**` tree against that folder.

Point every profile at the same local path and you get cross-profile sync. Put that path
inside Dropbox / iCloud Drive / Drive, or `git init` it, and cross-machine sync comes free
without us writing a line of network code.

### Why not the alternatives

- **`chrome.storage.sync`** is the native cross-profile channel, but it replicates
  per-Google-account — and separate accounts are usually the _reason_ someone has separate
  profiles. It also caps at 100 KB total / 8 KB per item / 512 items, which forces chunking
  plus compression and still leaves a hard ceiling on how much memory can sync.
- **The loopback MCP broker** (`packages/mcp-server`, `ws://localhost:47821`) would give
  full fidelity, but only on one machine, and only for users who installed the CLI.
- A shared folder covers same-machine, cross-machine, and different-Google-account cases
  with one implementation, and the wire format is just the files.

### Convention alignment

This matches where the agent ecosystem has landed. Claude Code's auto memory is a
directory of markdown with a `MEMORY.md` index (`~/.claude/projects/<project>/memory/`),
Anthropic's API memory tool is a client-side `/memories` directory with strict path-prefix
confinement, and tools like basic-memory use Obsidian-flavored markdown with YAML
frontmatter and `[[wikilinks]]`.

OpenBrowse memory v2 already _is_ that format, so no format change is needed. Notably,
every one of those tools declares its agent-authored memory machine-local and punts
syncing to the user — Claude Code's docs say so explicitly. There is no sync convention to
conform to; a folder of markdown is the shape everyone would reach for.

## Vault layout

The vault mirrors the OPFS tree verbatim, so a user opening it in Obsidian sees exactly
what Settings → Memory shows.

```
<vault>/
├── memory/                          # mirrors OPFS memory/** 1:1
│   ├── garry-tan.md
│   └── projects/
│       └── openbrowse.md
└── .openbrowse/                     # sync metadata; hidden from Obsidian
    ├── vault.json                   # { vaultId, schemaVersion, createdAt }
    ├── tombstones/
    │   └── <sha256-of-path>.json    # { path, deletedAt, profileId, profileLabel }
    ├── conflicts/
    │   └── 2026-09-07T14-22-01Z/
    │       └── memory/garry-tan.md  # the version that lost a conflict
    ├── tmp/                         # staging for tmp-then-move writes
    └── lock                         # advisory; { profileId, acquiredAt }
```

Two deliberate choices here:

**No hash-cache manifest.** An earlier draft of this design put a `manifest.json`
in `.openbrowse/` to avoid rehashing files each pass. The implementation drops
it: both sides rehash every file on every sync instead. Memory trees are
markdown notes — tens to low hundreds of KB — so the hashing cost is
negligible, and a cache that must be invalidated correctly against hand edits,
cloud-rewritten mtimes, and concurrent writers is a bug surface bought for no
measurable gain. If a tree ever grows large enough to matter, the fix is an
mtime+size memo keyed locally, not a shared file in the vault.

**Tombstones are one file per deletion, not entries in a shared file.** A deletion is the
only fact that cannot be re-derived from the vault contents, so it must survive two
profiles writing concurrently. Per-path files have no write contention and cannot suffer a
lost update; had tombstones shared a single JSON file, one clobbering write would resurrect
every deleted note.

**No generated `MEMORY.md`.** OpenBrowse already computes a memory index and injects it
into the prompt. Writing it to disk would create a derived file that every profile
rewrites on every sync — a pure conflict generator.

## Per-profile local state

Kept in the profile, not the vault, because it is genuinely local knowledge and because
keeping it out of the vault removes write contention.

- **`Settings.memorySync`** (`chrome.storage.local`, via `storage.updateSettings`):
  `{ enabled, profileId, profileLabel, vaultId, lastSyncAt, lastResult }`, where
  `lastResult` is `{ pulled, pushed, deleted, conflicts, resurrected, error? }` from the
  most recent run — enough to render the status line without touching the vault.
  `profileId` is a UUID minted on first setup — `chrome.runtime.id` is identical across
  profiles and cannot distinguish them. `profileLabel` is user-editable ("Work") and is
  what conflict archives and status text name.
- **The directory handle** lives in a dedicated IndexedDB store (`memorySyncDb`, store
  `handles`, key `vault`). It must be IndexedDB: `FileSystemDirectoryHandle` is
  structured-cloneable but `chrome.storage` is JSON-only.
- **The baseline** — `path → sha256` as of the last successful sync — also lives in
  `memorySyncDb`, not in `Settings`. It is unbounded in size and the settings blob is read
  on every service-worker boot. The baseline is what makes three-way sync possible: it is
  how we tell "I created this file" apart from "the other profile deleted it."

## Sync algorithm

Three-way per-file reconciliation. For each path in the union of the local memory tree,
the vault memory tree, the tombstone set, and the baseline, compare `local`, `remote`, and
`base` hashes (`null` = absent):

| local    | remote             | base    | Action                                            |
| -------- | ------------------ | ------- | ------------------------------------------------- |
| = remote | = local            | any     | Nothing; refresh baseline                         |
| ≠ base   | = base             | present | **Push** local → vault                            |
| = base   | ≠ base             | present | **Pull** vault → local                            |
| ≠ base   | ≠ base             | present | **Conflict** → last-write-wins, archive loser     |
| absent   | = base             | present | Local delete → write tombstone, remove from vault |
| present  | absent (tombstone) | = local | Remote delete → remove local                      |
| ≠ base   | absent (tombstone) | present | **Delete-vs-edit → edit wins**, drop tombstone    |
| present  | absent             | absent  | New local file → push                             |
| absent   | present            | absent  | New remote file → pull                            |
| absent   | absent             | present | Deleted in both → drop baseline entry             |

Four properties worth stating explicitly:

**First sync never deletes.** With no baseline, every path falls into the "new" rows: the
run is a union merge. Adopting an existing vault pulls its notes and pushes yours; nothing
is removed. This is what makes linking a populated vault safe.

**Delete-vs-edit resurrects.** Losing a note you just wrote is worse than seeing one you
deleted come back, so an edit beats a concurrent delete and the tombstone is dropped. The
status UI reports it.

**Tombstones are retained for 90 days**, then garbage-collected by whichever profile
notices them expire. A profile that has not synced in over 90 days can therefore resurrect
a note deleted elsewhere — an acceptable trade against unbounded tombstone growth, and the
resurrection shows up in the status counts rather than happening silently.

**Conflicts are last-write-wins with the loser preserved.** The winner is chosen by the
`updated` frontmatter field, falling back to file mtime. The overwritten version is
written to `.openbrowse/conflicts/<iso>/<path>` — outside `memory/**`, so it never enters
the index, never becomes a second note for one entity, and never makes a `[[wikilink]]`
basename ambiguous (`memoryStore.graph` deliberately fans a shared basename out to _all_
matching files, so a `garry-tan (conflict).md` sitting in the tree would corrupt the
graph). Settings surfaces "2 conflicts resolved — review" with per-file view/restore.

### Hashing

`contentHash` in `lib/memory/format.ts` is 32-bit FNV-1a, which is fine for the local
index but too weak to arbitrate cross-profile writes. Sync hashes with SHA-256 via
`crypto.subtle.digest`, available in both pages and the service worker. The existing
`contentHash` is left alone.

### Writes

- **Into OPFS:** `OPFS.writeFileAtomic` (already tmp-then-rename), then
  `memoryStore.syncPath(path)` to reindex, then `emitVfsChange(path)` so open viewers
  refresh — the same three-step sequence `syncMemoryIndex()` in
  `lib/agent/tools/fs.ts` already performs. Deletes go through `OPFS.rm` +
  `memoryIndexDb` cleanup (the `memoryStore.deleteById` path).
- **Into the vault:** write to `.openbrowse/tmp/<rand>` then `FileSystemFileHandle.move()`
  into place. _To verify during implementation:_ `move()` support on local (non-OPFS)
  handles. If unavailable, fall back to a direct write — the next sync detects a truncated
  file by hash mismatch and repairs it, so correctness does not depend on atomicity.

### Concurrency

- **Within a profile:** `navigator.locks.request("openbrowse:memory-sync", …)`. Web Locks
  are scoped per storage partition, i.e. per profile, which is exactly the needed scope —
  it stops two open surfaces (Settings and the side panel) from syncing at once.
- **Across profiles:** an advisory `.openbrowse/lock` file carrying `{ profileId, acquiredAt }`,
  stolen if older than 60s. FSA offers no atomic exclusive create, so this is best-effort
  by construction. **The design is safe without it:** per-file hashing plus LWW means the
  worst outcome of a lost race is an extra entry in the conflict archive.

## Transport interface

The engine is transport-agnostic so the `chrome.storage.sync` and loopback-broker options
remain available later without rewriting reconciliation.

```ts
interface MemorySyncTransport {
  readonly id: string;
  status(): Promise<TransportStatus>; // granted | lapsed | missing | denied | unset
  reconnect(): Promise<TransportStatus>; // requires user activation
  listFiles(): Promise<RemoteEntry[]>; // { path, sha256, size, updated }
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  deleteFile(path: string): Promise<void>;
  listTombstones(): Promise<Tombstone[]>;
  putTombstone(t: Tombstone): Promise<void>;
  dropTombstone(path: string): Promise<void>;
  archiveConflict(path: string, content: string, at: string): Promise<void>;
  withLock<T>(fn: () => Promise<T>): Promise<T>;
}
```

`lib/memory/sync/engine.ts` is pure reconciliation over this interface plus a local-tree
port, which makes the whole case table unit-testable against an in-memory fake with no
OPFS and no filesystem.

## Trigger model and the permission constraint

A `FileSystemDirectoryHandle` survives in IndexedDB, but **its permission does not
reliably survive a session.** On a new session `queryPermission()` returns `"prompt"` and
`requestPermission()` requires user activation. Chromium will not show a permission prompt
from a worker with no open window ([crbug.com/1359786](https://crbug.com/1359786)), and
Chrome 122+ persistent permissions ("Allow on every visit") are scoped to installed apps,
with extensions historically buggy here ([crbug.com/40237487](https://crbug.com/40237487)).

Two consequences shape the architecture:

1. **The service worker can never sync.** The engine runs in an extension _document_
   (Settings, side panel, home). When the SW wants a sync — e.g. after an agent run — it
   broadcasts a request and whichever surface is open performs it.
2. **Sync is opportunistic, not continuous.** Treat a persistent grant as a bonus, never a
   foundation.

Sync fires when:

- **A surface mounts or regains focus** and permission is already `granted`.
- **An agent run finishes** and a surface is open.
- **`vfs:change` lands under `memory/**`**, debounced and coalesced.
- **The user clicks "Sync now."** Always available; the escape hatch when permission lapsed.

When permission has lapsed, sync silently skips and Settings shows a "Reconnect folder"
button — a click supplies the user activation `requestPermission()` needs. No prompt is
ever raised without a gesture, and the user is never nagged.

### No echo loop

Sync writes trigger `emitVfsChange`, which is bridged across contexts via
`BroadcastChannel` and would re-trigger the `vfs:change` handler. Two guards: a
module-level `syncing` flag suppresses the trigger for the duration plus a debounce
window, and the algorithm is idempotent — a second pass finds `local == remote == base`
everywhere and writes nothing. The flag is the optimization; idempotency is the guarantee.

## Security

Pulled files originate **outside the extension's storage** for the first time in this
codebase, so the trust boundary moves and needs explicit defenses:

- **Path confinement.** Every remote path is validated with `parseMemoryPath` and must
  resolve under `memory/` with `spaceId === null`. Reject any directory entry name
  containing `/`, `\`, or `..`, or beginning with `.`. This mirrors the invariant the
  memory tools already enforce (and that Anthropic's memory tool docs call out as
  mandatory), extended to an untrusted source.
- **Extension-only, `.md` only.** Non-markdown vault files are ignored, not imported.
- **Bounds.** Cap at 1,000 files and 1 MB per file per sync; report the overflow in the UI
  rather than importing a runaway or malicious tree.
- **Prompt-injection surface.** Anything in `<vault>/memory/**` becomes agent-readable
  memory. A shared or cloud-synced folder therefore becomes an injection vector, and the
  Settings copy and docs must say so plainly: point this at a folder only you control.

## UI

A **Sync** section at the top of `entrypoints/settings/MemoryTab.tsx`, above the existing
tree/viewer.

**Not configured:** one-line explanation, "Choose folder…", and a hint that placing the
folder in Dropbox/iCloud/Drive or a git repo extends sync across machines.

**Configured:** folder name; this profile's editable label; a status line
(`Synced 2 minutes ago` / `Syncing…` / `Reconnect folder` / `Folder not found — relink` /
error); a counts line (`14 notes · 3 pulled, 1 pushed`); **Sync now**; a conflicts entry
point when non-empty; **Stop syncing**, which unlinks and never deletes anything.

**Conflicts view:** entries from `.openbrowse/conflicts/`, each showing which profile
wrote the losing version, with view / restore / dismiss.

## Files

New:

```
lib/memory/sync/
├── engine.ts              # pure three-way reconciliation
├── types.ts               # MemorySyncTransport, tombstone, baseline, results
├── hash.ts                # SHA-256 over file contents
├── local-tree.ts          # OPFS memory/** port: list, read, write, delete
├── directory-transport.ts # File System Access implementation
├── db.ts                  # memorySyncDb: handle + baseline stores
├── controller.ts          # trigger orchestration, Web Locks, status
└── __tests__/
entrypoints/settings/memory-sync/
├── MemorySyncSection.tsx
└── ConflictsPanel.tsx
hooks/useMemorySync.ts
```

Modified: `lib/types.ts` and `lib/constants.ts` (`Settings.memorySync` + default);
`entrypoints/settings/MemoryTab.tsx` (mount the section); the SW's post-run path
(broadcast a sync request); `apps/docs/content/docs/memory.mdx`.

`memoryStore`, `memoryIndexDb`, `format.ts`, and the fs tools are **unchanged** — sync is
purely a new consumer of existing primitives.

## Test surface

Following the existing pattern in `lib/memory/__tests__` (fake OPFS + fake IndexedDB).

**Engine, against an in-memory transport fake:** every row of the case table; first-sync
union merge deletes nothing; tombstone propagation; delete-vs-edit resurrection;
LWW ordering by `updated` then mtime with the loser archived; baseline advancement;
idempotency (a second run writes nothing); rejection of traversal names, non-`.md` files,
space-scoped paths, oversized files, and file-count overflow.

**Transport, against a fake directory handle:** `prompt` permission yields `lapsed`
without throwing; a missing folder yields `missing`; the tmp-then-move write path and its
direct-write fallback; a corrupt `vault.json` is rewritten rather than fatal; tombstone and
conflict-archive round-trips; refusal of unsafe vault paths.

**Controller:** the profile id is minted once and stays stable; an opportunistic pass on a
lapsed grant is silent while an explicit one reports; concurrent calls coalesce into a
single pass; the self-writing flag clears even when a pass throws; unlinking forgets the
vault without deleting anything.

**Integration, real fake-OPFS + `memoryIndexDb`:** a pulled file becomes findable via
`memoryStore.search`; a pulled delete drops its index row and its link edges; syncing
twice performs exactly one set of writes (no echo).

**Guard:** sync can never write outside `memory/**` in OPFS.

## Rollout

1. Engine + types + hashing, with the in-memory fake. No UI.
2. `local-tree` and `directory-transport`; wire `memorySyncDb`.
3. `controller` with Web Locks, the permission state machine, and manual sync only.
4. Settings UI: link/unlink, status, Sync now.
5. Opportunistic triggers (focus, post-run, debounced `vfs:change`).
6. Conflicts panel.
7. Docs + changeset.

Steps 1–4 are independently shippable as manual-only sync, which is a coherent feature on
its own; step 5 is what makes it feel like sync.

## Follow-ups

- **Space memory** via an explicit portable `Space.syncKey` and opt-in pairing per space.
  Never by name-matching.
- **Additional transports** behind the same interface: `chrome.storage.sync` for
  zero-setup same-account sync; the loopback broker for full-fidelity same-machine sync.
- **`memory.mdx` is currently stale** regardless of this work — it documents the removed v1
  tools (`saveMemory`, `recallMemory`, `updateMemory`, `deleteMemory`) and says memories
  live in "extension storage." Worth correcting alongside the new Sync section, and the
  "never sent to external servers" callout needs the nuance that a user may _choose_ to put
  the vault in a cloud-synced folder.

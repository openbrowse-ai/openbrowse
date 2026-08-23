---
"openbrowse": patch
---

Stop Chrome from silently deleting all local data — conversations, memory, Space files and artifacts — when the disk fills up.

Chrome keeps every origin’s IndexedDB / OPFS / Cache data in a storage bucket that is `best-effort` by default, and evicts best-effort buckets **in their entirety** under storage pressure, least-recently-used origin first. The extension never opted out, so on a full disk one profile lost its entire chat history, the whole agent memory tree, every file uploaded to a Space, and all artifacts in a single eviction — IndexedDB and OPFS together, which is the signature of a bucket wipe rather than a bug in our code. The only trace left behind was a LevelDB line reading `Creating DB ... since it was missing`, and because none of this data is mirrored to a server, there was nothing to restore from.

Two layers now protect it:

- **`unlimitedStorage` manifest permission.** The load-bearing fix: per Chrome’s extension storage docs it “exempts extensions from both quota restrictions and eviction”. It triggers no install-time permission warning, so existing installs pick it up on update without a re-consent prompt.
- **`navigator.storage.persist()` on startup.** Belt and braces, in a new `@/lib/storage-persistence` module. Note this cannot live in the service worker: `StorageManager.persist()` is `[Exposed=Window]`, so only `persisted()` and `estimate()` exist on `WorkerNavigator`. It is called from the four document surfaces (newtab, home, sidepanel, settings) instead, memoized per document, and skipped when the bucket is already persistent. Chrome is known to leave extension buckets non-persistent even when the call resolves, so a `false` result is logged as information rather than treated as an error.

The module also warns when `estimate()` reports less than 256 MiB of quota remaining for the origin — a heads-up that writes are close to failing with `QuotaExceededError`. To be precise about what that number is not: Chromium sizes an origin’s quota from *total* disk size, and the Storage Standard requires that it “must not be a function of the available storage space on the device”, so this is a quota-headroom signal only. It does not measure disk pressure and does not predict eviction.

This reduces the risk of eviction but does not make local-only data durable on its own — there is still no export or backup path, and a user who clears site data or hits a corrupted profile has no way back. That remains worth fixing separately.

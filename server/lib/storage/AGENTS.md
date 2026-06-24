# AGENTS — `server/lib/storage/`

## Purpose

`server/lib/storage/` owns the **StorageProvider** abstraction: the seam between
customware logic and _where L1/L2 state physically lives_. It exists so the
otherwise-stateless shell can scale horizontally without forking user state on
local disk (the split-brain risk called out in the review and ADR-003).

## Files

- `storage_provider.js` — the async contract (`StorageProvider` typedef),
  `STORAGE_PROVIDER_METHODS`, and `assertStorageProvider()`.
- `local_disk_provider.js` — `createLocalDiskStorageProvider()`, the default,
  backed by `node:fs`. Preserves today's on-disk behaviour exactly.
- `index.js` — `createStorageProvider()` (selects by `STORAGE_PROVIDER` env),
  `getStorageProvider()` singleton, `setStorageProvider()` for tests/hosts.

## Contract

- Methods are **async** (object stores / databases cannot be synchronous).
- Implementations operate on absolute logical paths; non-filesystem backends map
  a path to a key, typically under a configured prefix.
- All methods reject on failure **except** `exists`, which resolves `false`.
- `writeFile`/`copy`/`move` create parent directories; `remove` is recursive and
  does not error when the target is absent.

## Configuration

- `STORAGE_PROVIDER` — `local` (default). `s3` and `db` are reserved names that
  throw until an implementation is registered in `index.js`.

## Status & migration plan (IMPORTANT — read before extending)

This is an **in-progress migration**. The default `local` provider is
functionally identical to the direct `node:fs` calls customware otherwise makes,
so behaviour is unchanged at every step.

Progress:

1. ✅ **`customware/file_access.js` — all mutating commits** now go through
   `getStorageProvider()` and are async: `writeAppFiles`/`writeAppFile` (write),
   `copyAppPaths`/`copyAppPath` (copy), `moveAppPaths`/`moveAppPath` (move), and
   `deleteAppPaths`/`deleteAppPath` (delete). The provider preserves the prior fs
   semantics — copy `errorOnExist`, delete error-on-missing (`force:false`), move
   EXDEV copy+remove fallback — so the default local provider is
   behaviour-identical. Callers updated to `await`: `api/file_write.js`,
   `api/file_copy.js`, `api/file_move.js`, `api/file_delete.js`,
   `api/module_remove.js`, and the `tests/file_write_operations_test.mjs` +
   `tests/user_folder_quota_test.mjs` tests.
2. ⬜ **`file_access.js` reads** still use synchronous `fs`: `buildWriteBuffer`
   (append/insert reads), `readAppFile`/`readAppFiles` (`readFileSync`/`statSync`
   ~800–1030), and `listAppPaths`. With the default local provider these hit the
   same disk as the migrated writes, so behaviour is consistent; a non-local
   provider needs reads migrated too before it is correct. (Larger ripple — every
   reader becomes async.)
3. ⬜ `customware/group_files.js` — `group.yaml` read/write helpers.
4. ⬜ `customware/git_history.js` — local Git history. Git assumes a real
   filesystem; a non-local provider needs a different durability story
   (e.g. snapshotting), so this is the last and hardest piece.

Continue incrementally, one call path at a time, keeping `local` as the default
so each step is verifiable against current behaviour. Only once L1/L2 reads and
writes flow exclusively through the provider can an S3/DB backend be added and a
multi-replica shell deployment share state safely.

## Local contracts

- Customware code should depend on `getStorageProvider()`, never on `node:fs`
  directly, once migrated.
- Do not re-implement path normalization here — that stays in
  `customware/layout.js`. Providers receive already-resolved absolute paths.

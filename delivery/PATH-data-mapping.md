# The path to "all my data mapped, sorted, and described"

**Status: COMPLETE AND PROPOSED by claude-fable-5-2, 2026-11-14. Unsigned. Nothing in it takes
effect until the owner signs it; a KEL signature is never transcribed by an agent.**
This is a reading of the board and the code as they stand, and the shortest order through what is
already signed. Where it recommends a cut, the cut is the owner's to take or refuse.

## Where it really is (measured 2026-11-14, read-only)

| | |
| --- | --- |
| F: catalogue | **1,117,007 files, 1.55 TB, every one fingerprinted** (pass finished 2026-10-25) |
| Duplicates on F: | 237,509 sets, 552,532 surplus copies, **267.6 GB** |
| By kind | images 873 GB, video 547 GB, other 84 GB, archives 25 GB, audio 14 GB, code 7 GB, documents 0.8 GB |
| Catalogue age | **20 days.** Nothing rescans it; the rescan job is S23 |
| Folder weights (S26) | **never built on the real catalogue** — S26 merged after the last pass |
| C: | **not catalogued.** 47 GB free of 476 GB |
| Backup drives, ASUS, Pi | not catalogued |
| main | w0, s3, s4, s17, s20, s21, s22, s26 gates green, 0 skipped; 61 commits unpushed |
| U0 | passed round 4, unmerged at 1,029 of 800 |

## What the review found

1. **The MVP walk-through has never been walked.** M13 is one journey with the owner at the
   keyboard. Its two build blockers (S21, S22) cleared on 2026-10-24. Everything built since —
   S25, S26, S27, S28, S29, U0 — is outside it. It costs no build and it is the only definition of
   done this project has.
2. **Verification is the cost, not the code.** S26 took six rounds, U0 four, and both overran
   their bands. Sixteen contracts remain between here and Benny answering over everything
   (S23, S24, U1–U9, K0–K5). At October's pace that is four months or more.
3. **Half of EP-U is not on the path to metadata.** U2–U5 (replicated ledger, Pi role, digests on
   the wire, cross-drive requests) exist so several machines can agree. Every backup drive is USB
   and can be catalogued plugged into the T480. Only U0 and U1 are authored, so deferring U2–U5
   costs nothing already written. What it leaves uncovered: the ASUS's internal disk and the Pi.
4. **S23's main saving has already been paid for on F:.** It was designed to avoid reading 1.55 TB;
   that read is done. It still earns its place for the 4–13 s Everything rescan, the scheduled
   rescan, and every drive not yet read — but if it starts to overrun, levels are the part to drop.

## The path

One contract in flight at a time. Each phase ends in something the owner can see in the app.
Durations are October's measured pace (about five working days a contract, verification included),
not commitments.

| Phase | Work, in order | Done when the owner sees | Human stop | About |
| --- | --- | --- | --- | --- |
| **0 Unblock** | decisions D1–D4 below; merge U0; push main | the Drives tab on main | the decisions | a day |
| **1 Walk the MVP** | none. The M13 journey once; S25 finishes alongside | what is on F:, Benny answers and cites, an approval on the record | an hour at the keyboard | a day |
| **2 The T480 mapped** | U0a → S23 → U1 → K0 preliminary | C:'s user folders beside F:; "what in Downloads is not on F:"; the capacity report | U1 (reads user data) | 4 weeks |
| **3 Every backup drive mapped** | plug each drive in, press Catalogue; U6–U9 are authored meanwhile | every drive in the registry with what is only on it | plugging drives in | days, yours |
| **4 Metadata complete** | S24 → K1 (to author) | photos by date and camera, RAW+JPEG as one shot, instant find over every name | none | 2 weeks |
| **5 Sorted** | U6 → U7 → U8 → U9, single-machine | sole copies, a plan, signed read-back-verified copies, one drive retired by certificate | U8 (writes data); the replica drive bought | 4 weeks + copy time |
| **6 Knowledge** | K2 → K3 → K4 → K5 | Benny answers across documents, meaning and graph, each answer citing | K2 (reads contents) | 4 weeks |

**Phase 4 is "all the metadata for my data" — about seven weeks from phase 0. Phase 5 is "sorted".
Phase 6 is where the shared brain starts.**

### Entry and exit, so no phase can be called done by its author

- **0 → 1:** U0 merged, w0 green, main pushed.
- **1 → 2:** the journey completed by the owner, or its first stop logged in `board/LOG.md` in
  their words. A stop becomes the next contract and goes ahead of phase 2.
- **2 → 3:** U1's pre-registered criteria reported from the real T480 (0 rows and 0 reads under
  Windows, Program Files, ProgramData, AppData; 0 OneDrive files hydrated), and K0's preliminary
  report on screen.
- **3 → 4:** every drive the owner owns appears in the registry as catalogued, or is named as not
  yet seen. An unattached drive is never counted as coverage.
- **4 → 5:** K1 answers a find over every catalogued drive without touching a disk.
- **5 → 6:** EP-U's own exit, single-machine: one real backup drive consolidated onto F:, every
  copy read back, then retired by a signed certificate with 0 sole copies.
- **6 → shared brain:** M12's exit — owner-chosen questions answered with citations, no
  quarantined file in any index.

## Decisions, each with a recommendation

| # | Decision | Recommendation | Why |
| --- | --- | --- | --- |
| **D1** | U0's overrun, 1,029 of 800 | **Accept, as a size-pinned grant** like S26's, so growth past 1,029 fails again | Four rounds found no padding; splitting it buys a fifth round and no product change |
| **D2** | U0's two missing lines: the KEL event schema, and `library.mjs` | **Merge U0 as verified; put both lines in a new small contract U0a** (band S) | Keeps a PASS intact instead of reopening it. Without them attach/detach events never land and an unplugged drive loses its catalogue date — both matter in phase 3 |
| **D3** | S25: allow `tests/librarian_mcp_boot_test.mjs`, or drop the empty-find refusal | **Allow the line; keep the refusal** | A shared brain is the wrong place for "an empty question returns everything". It is built, 216 of 300, one round from done |
| **D4** | Defer U2–U5 (replicated ledger, Pi role, digests on the wire, cross-drive requests) until after phase 4 | **Yes** | None is needed to catalogue a drive plugged into the T480, and none is authored. The ASUS's internal disk and the Pi stay uncovered and K0 says so by name |
| **D5** | S23 as signed (700) | **Build as signed. If the half-way reading passes 60%, drop levels and keep the Everything listing and the rescan job** — do not raise the band | F: is already fully fingerprinted, so levels are the part that has lost most of its value. Owner questions as the contract recommends: rescan every 24 h, Everything stays at login, integrity checking waits |
| **D6** | U1's owner questions | **As the contract recommends:** user-folder catalogues in `BENNY_HOME`, removable drives in `ESTATE_STORE`; no extra profile folders yet; the ASUS run NOT MEASURED | Consistent with D4 |
| **D7** | K0's defaults and the purchase | **2 copies, 3 years, 20% headroom, buy against the upper bound, and buy after phase 3** | Buying before the backup drives are catalogued sizes for duplicates. A mirror of F: can never need more than F:'s own 5 TB |
| **D8** | S24's owner questions | **As the contract recommends:** no visual similarity, no video probing, zips only | Each is a new native dependency; EXIF covers the 873 GB that matters |
| **D9** | S28 and S29 signatures | **Leave unsigned for now** | Neither is on the path. If the walk-through hits a locked catalogue, S29 becomes the next work by the rule below |
| **D10** | The audit event on `/library/neighbours`, and the 1,500-file cap | **Add the event inside S29 when it is signed; leave the cap until the walk-through shows it refusing a folder the owner wanted** | Lineage should be complete; the cap is a product question only the owner's own use answers |
| **D11** | Pushing main (61 commits) | **Push after U0 merges. No release** | A month of verified work exists in one working copy |
| **D12** | U6–U9 | **Author them single-machine during phase 3, sign before phase 5; U8 reuses robocopy with read-back** | They read local catalogues directly instead of a replicated index; U2–U5 can be added later without rewriting them |

## Three rules taken from the record

- **Ask for the band at half-way, on the S27 reading** — not at the end, on a figure from a second
  script. Both U0 budget errors came from that.
- **Real data before hand-off.** From phase 2 on, the author smokes every contract on the real
  catalogue first; S26's 93-second freeze and S21's D3 only showed at 1.1 million rows.
- **A stop in the walk-through outranks the queue.** Whatever phase 1 trips on is the next work.

## What this plan does not do

It does not cover the ASUS's internal disk or the Pi until U2–U5 return. It does not release an
installer. It does not delete anything, at any phase: duplicates are reported, copies are
verified, drives are retired by certificate, and the product never wipes.

## Signing

The owner signs this plan by saying so. "Signed" takes every recommendation; "signed except Dn"
takes the rest. On signature the agent transcribes D1–D12 to `board/LOG.md`, authors U0a, and
starts phase 0. No KEL event is written by an agent.

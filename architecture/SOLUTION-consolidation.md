# SOLUTION — Consolidation: one estate, every copy known (EP-U)

_Authored 2026-10-11 by claude-opus-5; signed by the owner as written 2026-10-11 (§14 answered by the recommendations)._

## 0. Why, and why now

The owner's use case (2026-09-21, restated 2026-10-03) is to merge the backup drives onto the F:
Elements, then let Prime-Silo manage the store. Drives come and go, an unattached drive is never
coverage, and duplicates are reported, not deleted. The librarian (S21–S24) gives each drive a
catalogue: every file with its size and date, fingerprints where a question needs them, duplicates
exact, and possible duplicates for review. EP-U extends that from one drive to **every drive on
every machine**, and then does the one thing the estate has never done safely: copy what is
missing to where it belongs, verified, so a backup drive can be retired knowing nothing was lost.

It replaces the parts of EP-S designed before the librarian existed (§12).

## 1. The estate it works on

- **T480** (main): C: (internal), F: (WD Elements USB, 1.55 TB, 1,117,018 files), the NAS share
  `\\T480\nas` on `F:\nas`, and backup drives when plugged in.
- **ASUS** (portable replica): its own internal drive or drives. Reachable over Tailscale SSH; LAN
  is blocked while its WiFi is Public.
- **Pi 5** (always-on anchor, Linux): its own storage. Everything does not run there, so it uses the
  walker.
- **OneDrive**: the binary16 tree and other synced folders. Online-only files must never be read,
  because reading downloads them.

## 2. Invariants (normative for every EP-U contract)

1. **Fingerprint where the disk is.** A drive is catalogued by the machine it is attached to, never
   read across the network. Machines catalogue in parallel, so the estate's first index takes as
   long as its slowest drive, not the sum.
2. **Nodes name files; the hub names content.** Nothing that crosses the wire carries a file name,
   a path or a folder name: only sizes, fingerprints, counts, kinds, scopes and opaque folder
   fingerprints. A plan the hub makes says "content X, Y bytes, from drive A to drive B". The node
   that executes it resolves X to paths locally. This is stronger than S0's allowlisted roots, and
   it removes the need for S18.
3. **Nodes push; the hub never reaches in** (EP-S). A request the hub has for a node, such as a
   fingerprint or a copy, waits until the node next pushes and pulls it.
4. **A drive is its identity, never its letter.** Windows uses volume serial plus root file ID (S20,
   S21). Linux uses the filesystem UUID.
5. **Unattached is never coverage.** A copy counts only on a drive whose catalogue is fresh, i.e.
   seen within `ESTATE_COPY_FRESH_DAYS`, default 30.
6. **Only identical bytes can be acted on.** S24's ladder applies estate-wide. Review-only rules
   never feed a plan.
7. **Nothing is deleted by the product.** Copies are added; drives are retired by a certificate the
   owner signs, and the owner then does what they like with the drive. Duplicates are reported
   (owner, 2026-09-21). The optional U8 moves identical copies to a holding folder; even that is the
   owner's signed act, and emptying the holding folder is the owner's act.
8. **Every write is signed and recorded.** Copies go through the N5 governance flow. Each placed copy
   is an `artifact_placed` event carrying `derived_from` its source, which also closes the estate's
   lineage gap ("ORIGIN RECORDED 0/N").

## 3. The shape

```
 each node (T480, ASUS, Pi)                              hub (T480)
 ┌──────────────────────────────┐   push: digests   ┌──────────────────────────────────┐
 │ librarian per drive (S21–24)  │ ───────────────▶ │ drive registry (U0)               │
 │  catalogue: names + levels    │                  │ estate content index (U2):        │
 │ digest builder (U2):          │ ◀─────────────── │   content → drives, copies, fresh │
 │  sizes, fingerprints, counts  │   pull: requests │ cross-drive levels (U3)           │
 │ executor (U6): content→paths  │   (fingerprint,  │ copies & risk (U4)                │
 └──────────────────────────────┘    copy, verify)  │ policy + planner (U5) → proposals │
                                                    └──────────────┬───────────────────┘
                                                      owner signs in the UI (N5)
```

## 4. Drive registry (U0)

Every drive any node has catalogued is one registry row:
- identity, a label (the volume label, editable by the owner) and the machine last seen on;
- medium: internal, USB, network, cloud;
- capacity and free space; first and last seen;
- the catalogue's last finished pass.

Attach and detach are events. A re-plugged drive at another letter, or on another machine, is the
same row. This is the estate's answer to "which drives do I have, and when did I last see each?".

## 5. Every node catalogues its own drives (U1)

The S21–S23 librarian runs on each node over the drives that node offers: Everything on Windows,
the walker on the Pi. It is started from that node's own Library tab, or by a hub request the node
pulls. S23's scope rules apply everywhere: rebuildable, tiny and junk files are catalogued but not
read, and online-only cloud files are never read. On the Pi the identity comes from the filesystem
UUID.

## 6. What crosses the wire (U2)

Per drive, a digest built from its catalogue:
- **Sizes:** the distinct sizes of owner-scope files, with counts. This is enough for the hub to
  see cross-drive duplicate candidates without a single fingerprint.
- **Fingerprints:** for files that have them, (size, partial, full) with counts.
- **Folder fingerprints** (S24), opaque: a hash of sorted (hashed relative name, size, fingerprint).
  Two drives can learn they hold the same folder without either name crossing.
- **Totals** by kind and scope; private files counted, never named.

The first digest is a snapshot stored in CAS (L1). Later pushes are deltas since the last
acknowledged run. Estimate for F:: owner-scope fingerprints for about 137k files plus about 46k
distinct sizes is well under 25 MB for the first push. A no-change delta is tiny. Both sizes are
pre-registered (§13). The push rides the N7 register path (shared key, LAN or tailnet), with the
same refusal without a policy.

## 7. The estate content index and cross-drive levels (U3)

The hub folds digests into one index: content → which drives hold it, how many copies, and how
fresh each catalogue is. **Levels across the estate:** a size held on two or more drives, where
not every holder has a fingerprint, becomes a **fingerprint request** to the nodes that lack one
(partial first, full on a partial match). The node pulls it with its next push, computes the
fingerprint locally, keeps it in its catalogue (S23's on-demand rule) and pushes the result. A few
rounds converge. A file is never read unless some other drive in the estate has a file of its
size.

## 8. Copies, sole copies and coverage (U4)

Per content, the index counts copies on **distinct physical drives with fresh catalogues**,
distinct machines, and cloud (counted separately, never as one of the physical copies). Reports:
- **Sole copies**: content on exactly one fresh drive, the files at risk, by drive, kind and bytes.
  It is as important as the duplicates report.
- **Coverage by folder**: e.g. "G:/Photos/2019: 100% has 2 or more copies elsewhere", from opaque
  folder fingerprints. The owning node shows the folder's name.
- **Stale**: copies on drives not seen within the freshness window, which never count as coverage.
- **Rebuildable** is excluded throughout.

## 9. Storage policy and the planner (U5)

`coordination/estate/storage-policy.yaml` is owner-edited in the UI, and each edit is a signed config
change. It holds:
- **Target:** where consolidated content goes, e.g. F:, laid out as
  `F:/consolidated/<drive label>/<original path>` (owner question 2).
- **Minimum copies:** e.g. 2 on distinct physical drives, at least 1 not attached to the T480
  (owner question 1).
- **Never move:** categories or drives the planner must leave alone.
- **Rebuildable:** never consolidated.

The pure planner diffs the index against the policy and raises **proposals only**, through the
N5 ledger:
- "copy 41,203 files (612 GB) from G: to F: — content not on F:";
- "make a second copy of 9,876 sole-copy files (140 GB) on the mirror drive";
- "drive G: is now fully covered: eligible for retirement".

Each proposal carries bytes, file count, free space at the target, and the sole-copy effect before
and after.

## 10. The signed copy (U6, re-scoping S7)

On a signed proposal, the node that has the source and target attached executes it. That is the
T480 for backup drive to F:. For the ASUS to the T480, the ASUS reads locally and writes to the
`\\T480\nas` share, and the T480 verifies on arrival.
- The copy is streamed and fingerprinted as it is read; the target is written, then **read back and
  fingerprinted**. The copy counts only if the two match. The extra read is the price of trusting a
  USB disk.
- It never overwrites: a name collision under the origin folder gets a suffix and is reported. It
  preserves modified times, handles long paths, checks free space before starting, and is
  restartable and stoppable, single flight per drive.
- Each verified copy is written straight into the target's catalogue as a level-2 row (no re-scan),
  with an `artifact_placed` event `derived_from` its source content and drive.
- **Nothing at the source is touched.** S7's original "evict at source" is dropped (invariant 7).

## 11. Retiring a drive (U7)

When every owner-scope file on a drive has the policy's minimum copies **on other fresh drives**,
verified, with no sole copies, the drive is eligible. The owner signs a **retirement certificate**:
a KEL event `drive_retired` carrying the drive identity, the coverage counts, and the catalogue pass
it was judged from. The drive then shows as retired; plugging it back in is noticed. Prime-Silo
never wipes it.

**A warning built in:** consolidating several backup drives onto one USB disk makes that disk a
single point of failure. The certificate's rule counts copies excluding the drive being retired, so
the planner will propose a second copy before it lets a drive go (owner question 1).

## 12. What EP-U replaces (owner decides at signature)

| EP-S task | Status | Becomes |
| --- | --- | --- |
| S5 integrity (coverage, sole copies, bit rot) | PARKED 10-03 | U4. Bit rot stays out (S23 owner answer: later) |
| S6 storage policy + planner | AUTHORED | U5, over the content index rather than the map fold |
| S7 governed executor | AUTHORED | U6: copy and verify only, no source eviction, content IDs resolved on the node |
| S18 owner names listable folders | PARKED 10-03 | not needed: no names cross (invariant 2) |
| S19 cross-machine duplicates and sole copies | PARKED 10-03 | U2–U4 |
| S8 elevation broker | AUTHORED | unchanged, stays in EP-S |

## 13. Pre-registered criteria (recorded before any build)

1. Every drive attached to the T480 and the ASUS is in the registry by identity. A drive re-plugged
   at another letter is the same row.
2. **No name crosses:** a byte scan of every push finds none of the node's catalogue names or path
   segments (UTF-8 and UTF-16LE).
3. The first digest of F: is ≤ 25 MB; a no-change delta is ≤ 100 KB.
4. Copy counts in the hub index equal a brute-force recount from the node catalogues on a sample of
   10,000 contents.
5. Cross-drive levels read a file only when another drive has its size. The count of files read
   equals the count of cross-drive size-sharers lacking a fingerprint.
6. **One real backup drive is consolidated onto F:**
   - every copied file is verified by reading it back;
   - 0 overwrites, and provenance is recorded for each;
   - large-file copy throughput is ≥ 80% of the slower drive's sequential speed;
   - a retirement certificate is issued with 0 sole copies under the policy.

## 14. Owner questions (answer at signature)

1. **The second copy.** After consolidation, F: holds most things alone. Recommendation: keep one
   backup drive as an **offline mirror of F:**, kept current by the same signed copies, and retire
   the rest. The Pi's storage can hold a third copy of critical categories later.
2. **Layout on F:.** Recommendation: `F:/consolidated/<drive label>/<original path>`. It keeps each
   source's structure, never collides, and leaves reorganising for later. The alternative is
   merging into F:'s existing folders.
3. **Private files in the hub index.** Their fingerprints and counts only, never names or paths.
   Recommendation: yes; otherwise private documents can never be counted as backed up.
4. **OneDrive.** Recommendation: counted as a cloud copy, separately, never as one of the minimum
   physical copies; online-only files are never read.
5. **U8, holding-area de-duplication on the target.** Recommendation: later. Reports first.
6. **Replacing S5, S6, S18 and S19 and re-scoping S7** as in §12. Recommendation: yes. They are
   parked or rewritten with a pointer here.

## 15. Out of scope

- Reorganising F:'s folder structure; renaming files.
- Bit-rot verification of every file (S23 owner answer: later).
- Cloud fingerprints (OneDrive's own hashes) and cloud as a copy target.
- Machines outside the owner's estate; anything over the public internet beyond the tailnet.

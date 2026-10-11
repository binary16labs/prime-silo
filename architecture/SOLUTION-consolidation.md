# SOLUTION — Consolidation: one estate, every copy known (EP-U)

_Authored 2026-10-11 by claude-opus-5; signed by the owner as written 2026-10-11 (§14 questions 1–6
answered by the recommendations). Amended the same day on the owner's direction: §5 (only the user's
data on Windows) and §16 (the replicated estate ledger and node roles; the old U2 split into U2, U3
and U4, later phases renumbered U5–U10). §14 questions 7–9 answered by the owner the same day, with two
new requirements: moving the main role between nodes, and primary/replica roles for data stores
(§16)._

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
   (owner, 2026-09-21). The optional U10 moves identical copies to a holding folder; even that is the
   owner's signed act, and emptying the holding folder is the owner's act.
8. **Every write is signed and recorded.** Copies go through the N5 governance flow. Each placed copy
   is an `artifact_placed` event carrying `derived_from` its source, which also closes the estate's
   lineage gap ("ORIGIN RECORDED 0/N").
9. **One writer per log; the ledger is every node's logs** (§16). No two nodes ever append to the
   same log, so the estate needs no locks, no voting and no single always-up server. Logs align by
   comparing their heads and sending what is missing.
10. **Catalogues never enter the ledger.** A catalogue holds names; it is a local working copy built
    from the disk. Only its names-free summary is a ledger event.

## 3. The shape

```
 every node, whatever its role                      the main node (T480 today)
 ┌──────────────────────────────┐                  ┌──────────────────────────────────┐
 │ librarian per drive (S21–24)  │                  │ owner's UI; signs (N5)            │
 │  catalogue: names, LOCAL      │                  │ folds every log into:             │
 │ its OWN log (one writer):     │   ledger sync    │  drive registry (U0)              │
 │  registry events, summaries   │ ◀──────────────▶ │  estate content index (U4)        │
 │  (U4), results, copies        │  heads compared, │  cross-drive levels (U5)          │
 │ executor (U8): content→paths  │  missing lines   │  copies & risk (U6)               │
 └──────────────▲───────────────┘  sent (U2)       │  policy + planner (U7) → proposals│
                │                                   └──────────────▲───────────────────┘
                │            ┌──────────────────────────────┐      │
                └──────────▶ │ Pi, always on: REPLICA (U3)   │ ◀────┘
                             │ every log; meeting point;     │
                             │ ledger backup; status page    │
                             └──────────────────────────────┘
```

Roles (§16): **main** (plans, owner signs, full replica), **replica** (every log, always-on meeting
point), **satellite** (its own log only, kept until a replica has it).

## 4. Drive registry (U0)

Every drive any node has catalogued is one registry row:
- identity, a label (the volume label, editable by the owner) and the machine last seen on;
- medium: internal, USB, network, cloud;
- capacity and free space; first and last seen;
- the catalogue's last finished pass.

Attach and detach are events. A re-plugged drive at another letter, or on another machine, is the
same row. This is the estate's answer to "which drives do I have, and when did I last see each?".

## 5. Every node catalogues its own drives (U1)

**Owner direction, 2026-10-11 (amends this section as signed):** "when looking at the windows
machine only look for where the user data is; do not carry the overhead of the operating system;
the downloads folder is a very good place to start". On a Windows **system drive** only the user's
data roots are catalogued:
- the known folders, resolved where they really are (U0): **Downloads first**, then Documents,
  Desktop, Pictures, Videos and Music;
- the OneDrive root;
- any profile folder the owner adds.

`C:\Windows`, Program Files, ProgramData and AppData are never read. Measured on the T480's C::
2,261,759 files and 494 GB in all, of which 184 GB is OS and app overhead, and the owner's known
folders are 5,719 files and 136 GB. **Data drives** (no Windows: F:, backup drives) are catalogued
whole, subject to S23's scope rules.

The S21–S23 librarian runs on each node over the drives and user roots that node offers: Everything on Windows,
the walker on the Pi. It is started from that node's own Library tab, or by a hub request the node
pulls. S23's scope rules apply everywhere: rebuildable, tiny and junk files are catalogued but not
read, and online-only cloud files are never read. On the Pi the identity comes from the filesystem
UUID.

## 6. What crosses the wire (U4)

Per drive, a digest built from its catalogue:
- **Sizes:** the distinct sizes of owner-scope files, with counts. This is enough for the hub to
  see cross-drive duplicate candidates without a single fingerprint.
- **Fingerprints:** for files that have them, (size, partial, full) with counts.
- **Folder fingerprints** (S24), opaque: a hash of sorted (hashed relative name, size, fingerprint).
  Two drives can learn they hold the same folder without either name crossing.
- **Totals** by kind and scope; private files counted, never named.

The first digest is a snapshot stored in CAS (L1), and an event in the node's own log points to it.
Later digests are deltas since the last one, as events in the same log. Estimate for F::
owner-scope fingerprints for about 137k files plus about 46k distinct sizes is well under 25 MB for
the first snapshot. A no-change delta is tiny. Both sizes are pre-registered (§13). Digests reach the
main node and every replica by ledger sync (§16, U2), not by a separate push. A node with no
quarantine policy writes no digest.

## 7. The estate content index and cross-drive levels (U5)

The main node, and any replica, folds the digests into one index: content → which drives hold it,
how many copies, and how fresh each catalogue is. Every replica computes the same index (§16).
**Levels across the estate:** a size held on two or more drives, where not every holder has a
fingerprint, becomes a **fingerprint request**: an event in the main node's log addressed to the
nodes that lack one (partial first, full on a partial match). The node receives it at its next sync,
computes the fingerprint locally, keeps it in its catalogue (S23's on-demand rule) and writes the
result to its own log. A few rounds converge. A file is never read unless some other drive in the estate has a file of its
size.

## 8. Copies, sole copies and coverage (U6)

Per content, the index counts copies on **distinct physical drives with fresh catalogues**,
distinct machines, and cloud (counted separately, never as one of the physical copies). Reports:
- **Sole copies**: content on exactly one fresh drive, the files at risk, by drive, kind and bytes.
  It is as important as the duplicates report.
- **Coverage by folder**: e.g. "G:/Photos/2019: 100% has 2 or more copies elsewhere", from opaque
  folder fingerprints. The owning node shows the folder's name.
- **Stale**: copies on drives not seen within the freshness window, which never count as coverage.
- **Rebuildable** is excluded throughout.

## 9. Storage policy and the planner (U7)

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

## 10. The signed copy (U8, re-scoping S7)

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

## 11. Retiring a drive (U9)

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
| S5 integrity (coverage, sole copies, bit rot) | PARKED 10-03 | U6. Bit rot stays out (S23 owner answer: later) |
| S6 storage policy + planner | AUTHORED | U7, over the content index rather than the map fold |
| S7 governed executor | AUTHORED | U8: copy and verify only, no source eviction, content IDs resolved on the node |
| S18 owner names listable folders | PARKED 10-03 | not needed: no names cross (invariant 2) |
| S19 cross-machine duplicates and sole copies | PARKED 10-03 | U4–U6 |
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
7. **The ledger aligns.** After any sync, every log's length and head on the main node and the Pi
   are equal, and the fingerprint of the folded state (registry, content index, copy counts) is
   identical on both.
8. **Sync is proportional to what is new.** A sync with nothing new sends ≤ 2 KB per log. A sync
   after a rescan sends only the new lines and any snapshot not already held.
9. **Tampering and forks are caught.** An edited line, a removed line, a line signed by an unknown
   key, or a fork (two different lines after the same head) is refused, set aside and reported.
   It is never merged.
10. **The Pi keeps the estate going.** With the T480 off, the ASUS syncs with the Pi, and the T480
    catches up from the Pi on waking with nothing lost. The Pi holds no file name (byte scan).
11. **The main role moves cleanly.** A planned handover from the T480 to the ASUS, and back, leaves
    exactly one main at every moment, with no log line lost. A forced handover followed by the old
    main's return demotes it at its first sync, and nothing it planned while away runs without a
    fresh signature.
12. **The Pi updates itself.** A new Prime-Silo version on the main node reaches the Pi add-on with
    no manual step, and the Pi never runs a version whose ledger format the main node lacks.
13. **A replica store stays a replica.** After a primary store gains content, the planner proposes
    bringing each replica store up to date, and after the signed copy, each replica's coverage of
    the primary's owner content is 100%.

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
5. **U10, holding-area de-duplication on the target.** Recommendation: later. Reports first.
6. **Replacing S5, S6, S18 and S19 and re-scoping S7** as in §12. Recommendation: yes. They are
   parked or rewritten with a pointer here.

From the §16 amendment, answered by the owner 2026-10-11:

7. **The Pi's operating system.** Owner: "maybe a add-on is a good place to start". The Pi replica is
   built as a **Home Assistant add-on** (a container).
8. **The Pi's maintenance and storage.** Owner: "it should not require manual update rather should
   access a main node or replica". The add-on is never maintained by hand: its **software follows
   the version the main node runs**, so ledger formats always match, and its **ledger comes from a
   main node or replica** by sync. The storage medium was not stated, so U3 reads it from Home
   Assistant and reports an SD card as a risk. The recommendation stays a USB SSD or NVMe as Home
   Assistant's data disk.
9. **The ASUS's role.** Owner: "ASUS should be a replica". It holds the whole ledger and can become
   main.

## 15. Out of scope

- Reorganising F:'s folder structure; renaming files.
- Bit-rot verification of every file (S23 owner answer: later).
- Cloud fingerprints (OneDrive's own hashes) and cloud as a copy target.
- Machines outside the owner's estate; anything over the public internet beyond the tailnet.
- Blockchain-style consensus or a voting protocol (Raft): no untrusted writers exist in the estate,
  and a protocol that needs a majority online would stall whenever the T480 and the ASUS are off.
- Home Assistant sensors, notifications and wake-on-LAN automations (a later, optional contract).

## 16. Amendment (owner direction, 2026-10-11): the replicated estate ledger and node roles

The owner asked "how do we establish a decentralised ledger, one that can be kept aligned and that
way fast, maybe have a main node, replica nodes with ledger, satellite nodes without", with "the home
assistant pi that is always on" in the picture.

**It builds on what the KEL already guarantees.** The KEL is append-only, one JSON object per line,
and each line carries `prev`, the hash of the line before, so an edit or a gap is detectable. Every
event already carries `machine`, a sortable `id` and an `hlc` (a hybrid logical clock that orders
events across machines whose clocks disagree). The spec already assumes one writer per log file, and
plans replication (L3) and delta cursors (L4). This amendment is that plan, made concrete for the
estate.

### The ledger (U2)

1. **One log per writer.** Each node appends only to its own logs, named by node and stream (e.g.
   `t480/estate`, `asus/estate`, `pi/estate`). The estate ledger is the set of every node's logs.
   Two nodes never write the same log, so writes never conflict.
2. **Alignment by heads.** A sync compares, per log, the line count and the hash of the last line.
   The side that is behind receives only the missing lines, checks they chain onto its own last
   line, and appends them **byte for byte**. Line endings are pinned (`*.jsonl -text`, the CRLF
   lesson), so no tool may rewrite a line. Cost is proportional to what is new, like `git fetch`.
3. **The same state everywhere.** Every replica orders all events by `hlc`, then `id`, and runs
   the same deterministic folds: the registry, the content index and copy counts. Replicas exchange
   a fingerprint of their folded state, which proves they agree.
4. **Signed, per node.** Each node has its own signing key, kept in its keystore under
   `BENNY_HOME/state`, and enrolled by the owner on the main node. It signs its log's head at each
   sync, and replicas refuse lines whose head is signed by an unknown or revoked key. This replaces
   the single shared N7 register key. The owner's approvals are signed on the main node, so
   replicas only ever verify: the owner's key never needs to be on the Pi.
5. **Forks are caught, never merged.** A fork (two different lines after the same head) can only
   come from a node's log restored from an old backup and written again. It is refused, the
   branch is set aside, and the owner decides.
6. **What is in it, and what is not.**
   - **Replicated, names-free:** registry events, catalogue summaries (U4), fingerprint requests
     and results, proposals, signatures, copy records by content and drive ID, retirement
     certificates. Large summaries are CAS blobs that events point to, so a blob already held is
     never sent twice.
   - **Never replicated:** catalogues and the per-file history logs, which name files. They stay on
     the node that owns the disk (invariant 10).

### Roles (U3)

`ESTATE_NODE_ROLE` is a runtime parameter, set with `node space set`.
- **main** (the T480 today): where the owner works, with the UI, the planner, the owner's
  signatures, and copies onto F:. Holds every log. Main is a role, not a data model, so it can
  move to another node by setting the parameter there and enrolling it.
- **replica** (the always-on Pi): holds every log.
  - **Meeting point:** satellites and other replicas sync through it while the main node is off;
    the main node catches up from it on waking.
  - **Ledger backup:** a second copy of the whole history, including every signed decision.
  - **Status page:** the read-only folds (drives last seen, sole copies, catalogue ages) stay
    viewable when the main node is off.
- **satellite**: writes its own log and keeps it only until a replica acknowledges it. It stores no
  other node's log, and receives only the requests addressed to it.

The estate's roles (owner, 2026-10-11): **T480 main, ASUS replica, Pi replica** (a Home Assistant
add-on).

### Moving the main role (owner requirement, 2026-10-11)

"I want to be able to move from main to replica." There is exactly one main at a time, and the move
is a signed, recorded handover, never a silent switch.
- **Planned handover** (both nodes reachable):
  1. The owner chooses the new main in the UI.
  2. The current main writes a signed `role_handover` event naming the new main and the head of
     every log it holds.
  3. The new main confirms once it holds those heads; the old main becomes a replica.
- **Forced handover** (the main is lost or away, for example the T480 is off while travelling with
  the ASUS):
  1. The owner confirms on the new main with their own signature.
  2. The event records the last head it held of the old main's log.
  3. When the old main returns, it sees the handover at its first sync and demotes itself to
     replica. Lines it wrote while away are its own log, so they merge cleanly; nothing it planned
     while away is executed without a fresh signature on the new main.
- **The owner's signing key moves with the main role,** exported and imported by the owner. It is
  never on a node that is only a replica.

### Store roles: a primary data store and its replicas (owner requirement, 2026-10-11)

"We need to be able to toggle things like the main data store that should have another replica."
Data stores get roles of their own, independent of node roles:
- **primary store**: where consolidated content lives. Today that is F: on the T480.
- **replica store**: a drive, by identity, that holds a full copy of the primary's owner content.
  The offline mirror of §14 question 1 is the first one.

Roles are signed ledger events, set and swapped in the UI. For example, if a NAS is bought later,
it becomes primary and F: becomes its replica. The planner (U7) raises "bring replica store X up
to date: N files, Y GB" whenever the primary has content the replica lacks. The signed copy (U8)
does it, with read-back verification. Copies and risk (U6) shows each replica store's coverage and
when it was last brought up to date. Swapping roles never moves data by itself: it changes what the
planner proposes next.

Transport is the existing HTTP surface over the LAN or the tailnet. A node syncs on start, when
another node becomes reachable, and on an interval. A satellite reaches the Pi over Tailscale
wherever it is, once Tailscale runs unattended on it (the owner's setting; S8's territory).

### The Pi

The Pi runs a Prime-Silo **replica** as a Home Assistant add-on beside Home Assistant (question 7).
It is never maintained by hand: its software follows the main node's version, and its ledger comes
from a main node or replica (question 8).
- It holds no file name, so a compromised Pi exposes counts and fingerprints, never the owner's
  files' names.
- It may later hold a third copy of critical small categories (§14 question 1).
- Home Assistant integration (sensors, notifications such as "backup drive G: not seen for 30
  days", wake-on-LAN of the T480 for scheduled copies) is a later, optional contract.

### Phase changes

The old U2 is split into three tasks, and the later phases are renumbered:
- **U2:** the replicated ledger.
- **U3:** roles and the Pi replica.
- **U4:** catalogue summaries into the ledger.
- Then U5 cross-drive levels, U6 copies and risk, U7 policy and planner, U8 signed copy, U9
  retiring a drive, U10 holding-area de-duplication.

Board IDs must be a letter followed by digits (`validate.mjs`, `work_loop.mjs`), so the split
takes whole numbers rather than U2a–U2c.

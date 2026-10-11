# EP-U — Consolidation (one estate, every copy known, nothing lost)

**Objective:** O2 (+ O4) · **Goals:** P2,P3,P4,P9 · **Milestone:** M11
**Plan source:** `../../architecture/SOLUTION-consolidation.md` (design, authored and signed by the owner as
written 2026-10-11). Builds on EP-S's librarian (S21 catalogue, S22 Benny, S23 levels and Everything, S24
possible duplicates), on EP-N (N5 signed governance, N7 register) and on EP-L (KEL, CAS).

Owner use case (2026-09-21, 2026-10-03): merge the backup drives onto the F: Elements, then let
Prime-Silo manage the store. Drives come and go, an unattached drive is never coverage, and
duplicates are reported, not deleted. Owner direction 2026-10-11: "think … when we go to index all
the machines and disks and consolidate the data how that can be handled".

**The one idea:** every drive is catalogued where it is attached. Only sizes, fingerprints and
counts cross the wire, never a name. The hub knows every copy of every piece of content and plans by
content. The node that owns the bytes resolves content to files and copies, verified by reading
back. A drive is retired by a certificate the owner signs once nothing on it would be lost.

## Phases → task contracts (M11)

- [ ] `U0` — drive registry: every drive by identity (Windows serial + root ID, Linux UUID), label, medium, capacity, last seen; attach/detach events _(agent-ok)_
- [ ] `U1` — every node catalogues its own drives with the S21–S23 librarian (Everything on Windows, the walker on the Pi), started from its own UI or a pulled hub request _(human-signed — reads every disk on every machine)_
- [ ] `U2` — digests cross the wire: sizes, fingerprints, counts and opaque folder fingerprints, a CAS snapshot then deltas over N7; the hub folds the estate content index; no name ever crosses _(human-signed — network surface)_
- [ ] `U3` — cross-drive levels: the hub turns sizes shared across drives into fingerprint requests that nodes pull, compute locally and keep _(agent-ok)_
- [ ] `U4` — copies and risk: copies on distinct fresh physical drives, sole copies, coverage by folder, stale copies; replaces S5 and S19 _(agent-ok)_
- [ ] `U5` — storage policy and planner: owner-edited policy (target layout, minimum copies, never-move), proposals only through N5; replaces S6 _(agent-ok — proposes, never executes)_
- [ ] `U6` — the signed copy: stream-fingerprint, write, read back, verify; never overwrite, never touch the source; place into the target catalogue with provenance; re-scopes S7 _(human-signed — writes data)_
- [ ] `U7` — retiring a drive: eligibility when everything on it has the minimum copies elsewhere; a signed `drive_retired` certificate; the product never wipes _(agent-ok — report + signed event)_
- [ ] `U8` — optional: identical copies on the target moved to a holding folder the owner empties _(human-signed — moves data; owner question 5)_

## Exit

All phase gates green and verified by a non-author agent. The T480's and the ASUS's drives (and
the Pi's, if its node runs) are in the registry and the content index. The pre-registered criteria
in the plan §13 are reported with measured numbers, including any that failed. **One real backup
drive is consolidated onto F:** every copy verified by reading it back, provenance recorded, then
retired by a signed certificate with 0 sole copies under the policy.

VISION-CHECK: which KRs moved (KR2.2 lineage now covers where every copy came from; KR2.4 governed
action on real data), and one honest sentence on what is still not covered. Privacy invariant: no
file name, path or content leaves a node; quarantined files are counted, never named.

# M11 — Consolidation → **v1.26.0**

**Scope (signed by the owner 2026-10-11, design source `architecture/SOLUTION-consolidation.md`):** EP-U U0–U7
(U8 optional). Every drive on every machine is catalogued where it is attached. Digests carrying
sizes, fingerprints and counts, never names, fold into one estate content index. Copies, sole
copies and coverage are known estate-wide. A storage policy raises proposals; the owner signs; the
owning node copies with read-back verification and provenance; backup drives are retired by signed
certificate.

**Trigger:** the backup-consolidation use case (2026-09-21) and the librarian re-plan (2026-10-03).
The owner asked on 2026-10-11 how indexing every machine and disk and consolidating would be
handled.

**Dependencies out:** EP-S S21–S24 (the librarian), EP-N N5 and N7 (DONE), EP-L L0 KEL and L1 CAS,
the artifact ledger. EP-S S8 (elevation broker) stays in M10.

**Human-signed stops:** U1 (reads every disk on every machine), U2 (network surface), U6 (writes
data), U8 (moves data, optional).

**Exit:** phase gates `scripts/gates/u0..u7` + non-author verification + the plan §13
pre-registered criteria reported with measured values. VISION-CHECK as EP-U.

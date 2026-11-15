# home_code integration: prime-silo the system of record, home_code the bridge

**Status: SIGNED by the owner 2026-11-15** ("You do it for me, take this as approval"), in reply to
the proposal below. The signature is board scope, transcribed by claude-opus-5-5. No KEL event was
written, because a KEL signature is the owner's alone. Epic **EP-H**. Its contracts are authored
after U7 and U8, so consolidation (`PLAN-consolidate-first.md`) keeps priority.

## Why

Since 2026-11-15, `OneDrive\binary16\home_code` (Antigravity on optimus) has rebuilt parts of what
prime-silo already does: a disk-scan registry, direct reads of the catalogues, an unchained event
log, direct Neo4j upserts and its own contracts. Two systems answering the same questions drift,
and where they read around prime-silo they skip its guards (privacy R31, the board's
author ≠ verifier).

## The rule

**prime-silo is the system of record. home_code is the bridge and cockpit.** home_code keeps what
only it does: the cross-machine handoff (`DUAL-BRAIN-SYNC.md`), progressive disclosure, the model
router and provenance cards. Wherever it repeats a prime-silo job, it calls prime-silo instead.

## Contracts (EP-H, to author in this order)

| ID | Contract | Done when |
| -- | -------- | --------- |
| H1 | **Read through the API.** home_code gets drives, sole copies and catalogue counts from `/api/estate/drives`, `/library/sole` and `/library`, never by opening `library-*.db` or `drives.db` | No home_code script opens a prime-silo catalogue file; privacy is applied once, in the hub |
| H2 | **One ledger.** home_code events land in a prime-silo hash-chained log per host; home_code's JSONL becomes a view | The chain verifies; no unchained "KEL" is left |
| H3 | **One graph writer per machine.** On the T480, Neo4j is written only through Benny/LONGVIEW; the home_code topology (estate twin, OS catalogue cards) becomes a LONGVIEW input | No direct Neo4j upsert from home_code on the T480 |
| H4 | **Contracts on one board.** HC-01..03 move onto the prime-silo board with independent verification, or are marked "home_code-only, unverified" | Each HC contract has a board status |
| H5 | **Optimus sessions to the T480.** Optimus's Antigravity sessions reach the T480's inventory and are privacy-gated and carded like the rest | LONGVIEW covers both machines |

## Until then

- No direct Neo4j writes from home_code on the T480 while a LONGVIEW run holds the graph.
- home_code writes stay inside home_code (not `PRIME_SILO_HOME`).
- Anything under OneDrive is read only with the cloud-only guard.

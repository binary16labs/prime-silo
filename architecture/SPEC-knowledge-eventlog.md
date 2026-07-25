# SPEC — Knowledge event log (KEL) (L0)

> The flywheel's single source of truth. Neo4j / Chroma / memo-ray / cards / the execution register
> are **rebuildable projections** off this log (owner steer 1). Normative for EP-L; the design it
> implements is [`SOLUTION-longview-self-learning.md`](SOLUTION-longview-self-learning.md) §4.1 / §5.1.
> Reference impl: `server/coordination/lib/kel.mjs` · Schema: `server/coordination/schema/kel-event.schema.json`
> Tests: `tests/kel/` · Gate: `node scripts/gates/l0.mjs`

## Doctrine (reused, not reinvented)

The KEL is the **same shape** as the B0 coordination ledger and the G0 run-event stream — one more
append-only, chain-hashed, `fold(events) → state`, non-blocking log. It reuses those exact mechanics
(`server/coordination/lib/ledger.mjs`): one JSON object per line; `prev = sha256(previous raw line)[0..16]`
(`"genesis"` for the first line), computed by the appender — **callers never set `prev`**; state is
derived **solely** by folding; and — per the G0 rule — a write that fails for I/O reasons **degrades to
a logged no-op, never raises** (the step's own success is unaffected).

## Location

Truth travels with the corpus on the portable drive (R21/R34) and is what R41 backs up:

```
D:\flywheel-staging\eventlog\<yyyy>\<mm>\events-<hlc-day-bucket>.jsonl   # append-only, chain-hashed
```

The library operates on a given log-file path; the caller resolves the date/HLC bucket. When the B1
server is up it is the single appender (as with B0); direct appends assume a single writer per file.

## Envelope (`kel-event.schema.json`)

Every event carries the **bi-temporal + provenance** envelope. Required: `id` (ULID), `schema_version`
(semver — steer 10), `type`, `valid_time` (when true in the world — R1), `txn_time` (when recorded —
R1), `time_confidence` (`known` | `inferred` — steer 8: `inferred` sets `valid_time = txn_time`, never
fabricates precision), `hlc` (wall-logical-node clock for skew-tolerant causal order across machines —
steer 7 / R11), `machine`, `authorship` (`human` | `frontier` | `house` — R38, captured at capture
time), `sid` (identity join to memo-ray/cards/quarantine — R4), `subject` (`{kind, id, content_hash?}`).
Optional: `payload`, `supersedes` (version links). **Unknown fields are permitted** (additive doctrine
/ G0); **missing required fields are rejected**. `prev` is appended by the writer, not supplied.

Event `type`s: `session_staged`, `card_asserted`, `entity_asserted`, `edge_asserted`, `concept_merged`,
`dataset_row_derived`, `model_recorded`, `execution_recorded`, `cursor_advanced`, `conflict_flagged`,
`tombstoned`, `schema_migrated`.

## Additive / bi-temporal semantics

- **Corrections never mutate** (R3/R5): a correction is a **new event** with a new `txn_time` and a
  `supersedes` link; prior raw lines are never edited or deleted. History is fully recoverable (R7).
- **Two time axes** (R2): fold with `valid_time ≤ T` to answer *"what was true at T"*; fold with
  `txn_time ≤ T` to answer *"what did we know/record at T"* (including reconstructing the exact
  knowledge state that produced an artifact). Latest transaction-time wins per subject; a `tombstoned`
  event removes a subject from the projection (privacy deletions are moved/journalled, reversible — R6).
- **Ordering-tolerant** (R11): events may arrive out of order across machines; the fold sorts by
  `txn_time` then `hlc`, so valid-time resolves the true sequence independent of arrival order.

## Replay across schema evolution (steer 10 / R32)

Every record is `schema_version`-tagged. The projector applies a registry of **versioned up-converters**
(`<from>-><to>`) so a record written under an older version is up-converted **at projection time** and
stays replayable; a breaking change ships a converter rather than migrating the log in place. The log
is never rewritten — additivity holds.

## Tamper evidence

Readers re-derive the chain; an edited historical line breaks the `prev`-hash of its **successor**,
reported by **1-based line number** (the successor's). Known limit (inherited from B0): an edit to the
*last* line has no successor to betray it — the B1 server anchors the head hash when it is up.

## Privacy (hard — R31/R4)

The KEL stores `sid`s; **projection** is where the leak-gate + quarantine/teleport filter is applied
(L9), so teleported sids never enter any projection at any point in bi-temporal time. The KEL itself
holds no job-application/CV content — that is excluded upstream at staging (R40) and never synthesized.

## Out of scope (this spec / L0)

The CAS staging store + manifest (L1), the inbound poison gate (L2), the delta cursor engine (L4), the
concrete store projectors + time-travel query surface (L8), and privacy-honoring conflict projection
(L9). L0 is the envelope + chain + fold + converter **mechanics** only.

# Solution Design — LONGVIEW self-learning system (the flywheel)

**Status:** DRAFT (design authored 2026-07-25) — §4 (architecture), §5 (schema/DDL) and §6 (task
breakdown) are now written and trace to R1–R45; §2/§3 remain the binding owner steers they were
handed off as. Open for owner review of the design itself (the R#s and steers are already accepted).

**Companion (read first, authoritative):**
[`REQUIREMENTS-longview-self-learning.md`](REQUIREMENTS-longview-self-learning.md) — R1–R45 + the
11 open questions. This solution doc traces every design choice back to an R#.

**Handoff author:** claude-opus (requirements+review session), 2026-07-25. **Design author:** claude-opus (design session), 2026-07-25.

---

## 1. Mandate (what this session produces)

Per the owner instruction that requirements and design are separate sessions, the requirements doc
states *what* and *why*; **this session states *how*** and breaks it into deliverable tasks. Produce:

1. **Solution design** — the architecture that satisfies R1–R45 (bi-temporal + additive + delta
   substrate; execution register; portable staging; the closed measured loop; agent loops).
2. **Schema / DDL** — concrete stores and shapes: the bi-temporal keys, staging manifest + blob
   layout on **D:**, execution-register schema, delta watermark/cursor placement.
3. **Task breakdown** — work contracts for the delivery board (`SPEC-work-contracts` format;
   red-first gates; `author≠verifier`), sequenced by the wave phasing below.

Out of scope (unchanged from requirements §3): replacing the model/training method — **EP-T stands**;
any cloud dependency — **local-first is a hard constraint**.

## 2. Definition of ready (gate BEFORE design proceeds)

Per requirements §7, design is "ready" once the owner has:
- accepted/amended/rejected each **R1–R45**;
- given a steer on each of the **11 open questions** (§6 + §9.3), or explicitly deferred it here;
- confirmed the §9.5 phasing (Tier 1 → wave 1) and the R17 "stage raw to D: now" quick win.

**Status of that gate: MET (2026-07-25).** The requirements owner has **accepted R1–R45 as a set**,
**steered all 11 open questions** (recorded in requirements §6.1), and **confirmed the phasing**
(Tier 1 → wave 1) and the R17 quick win. The design session proceeds against confirmed steers — the
decisions in §3 below are binding inputs, not assumptions. Any per-R# amendment surfaced during
design goes back to the owner.

## 3. Decisions to make (the 11 open questions — design fills these)

**All 11 steered by the owner on 2026-07-25** (authoritative record in requirements §6.1). These are
binding design inputs; the design session specs the composition where a steer says "hybrid."

| # | Question (short) | Owner steer (binding) | Traces |
|---|------------------|------------------------|--------|
| 1 | Bi-temporal storage | **Event-log-as-truth**; Neo4j/Chroma/memo-ray are rebuildable projections | R1–R4 |
| 2 | Staging format on D: | **Full hybrid** — CAS blob store (de-dup) + human-navigable machine/date index + per-machine manifest | R17–R20 |
| 3 | Delta watermark granularity | **Per-content-hash**; cursors in the event log / register | R8 |
| 4 | Execution-register | **Unified schema, backfilled** from train JSONs + LOG + LONGVIEW ledger + lineage | R12–R16 |
| 5 | Loop trigger + cross-machine claim | **Hybrid** file-watch + cron backstop; both under the B0/B1 single-winner claim | R28, R43 |
| 6 | Compound-value metric | **Triad shown together** — eval delta (anchor) + agent pass-rate + cost/task; no single composite | R26 |
| 7 | Multi-machine clock | **Hybrid logical clocks (HLC)** | R11 |
| 8 | Bi-temporal backfill | **Real timestamp where known, else valid-time = txn-time tagged inferred**; never fabricate | R2, R3 |
| 9 | Semantic conflict resolution | **Keep-both-and-flag**; surface to verifier/human, never auto-pick | R11 |
| 10 | Schema evolution | **Additive-default + versioned up-converters**; every record schema-version tagged | R32 |
| 11 | Loop-level liveness | **Full hybrid** — artifact/CPU watchdog + external supervisor + dead-man clean abort | R35 |

## 4. Architecture

**Reuse, do not rebuild** (requirements §2): the LONGVIEW ADR-005 pipeline; memo-ray / Chroma /
Neo4j / cards / rollups; the leak-gate + teleport/quarantine governance; the EP-T T2/T3/T4/T5
trainer + `house-trainer`; the delivery board (W0 contracts, B0 ledger, G0 run-events).

### 4.0 The one idea that unifies everything

The repo already runs **three append-only, chain-hashed, fold-to-state, non-blocking logs**:
`coordination/tasks.jsonl` (B0 — who is doing what), `runs/<id>/events.jsonl` (G0 — what one
execution did), and the delivery `LOG.md`. The flywheel adds **one more log of the same shape** —
the **knowledge event log (KEL)** — and reuses the existing doctrine (chain hash, `fold(events) →
state`, writers never raise for I/O) rather than inventing a new persistence model. Everything else
in §4 is either that log, a **projection** off it, or a **guard** around it.

```
                         ┌──────────────────── D:  (portable, backed up — R21/R34/R41) ─────────────────────┐
 many machines           │  flywheel-staging/                                                                │
 (Claude/Antigravity/    │   ├── blobs/…                CAS blob store  (identity = hash, de-dup — R17/R20)   │
  agent traces,   ──stage─►  ├── index/<machine>/<date>/ human-navigable pointers into blobs (R2 steer)      │
  memo-ray)              │   ├── manifests/<machine>.json  self-describing, plug-and-play (R18/R19)           │
                         │   └── eventlog/…             KNOWLEDGE EVENT LOG = truth (R1–R7, event-log steer)  │
                         └───────┬──────────────────────────────────────────────────────────────────────────┘
   R40 poison gate ──────────────┘ (inbound integrity, symmetric to the outbound leak gate R31)
                                  │
        ┌─────────────────────────┴── projectors (rebuildable — R32 replay) ───────────────────────────┐
        ▼                     ▼                    ▼                     ▼                                ▼
   Neo4j graph          Chroma vectors        memo-ray tree        LONGVIEW cards            execution register
   (projection)          (projection)          (projection)         (projection)         (SQLite projection, R12–R16)
        └───────────────── delta engine: per-content-hash watermarks (R8–R11), leak/teleport at every projection (R31) ┘
                                  │
   flywheel-daemon ──────────────┘  file-watch + cron backstop (steer 5), each turn gated by a B0 single-winner lease
   (loop orchestrator)              (R43/R28/R29) · watchdog+supervisor+dead-man liveness (R35, steer 11)
                                  │
        staged → synthesis → dataset(T2) → train(T3/T5) → serve(T4) → agents → new sessions  (closed loop, R22)
        every turn measured against the frozen instrument (R23) · triad dashboard (R26) · human-signed promotion (R39)
```

### 4.1 Knowledge event log (KEL) — event-log-as-truth  · R1–R7, R11, R32, steers 1/7/8/10

The KEL is the single source of truth; Neo4j, Chroma, memo-ray and cards are **rebuildable
projections** (steer 1). It lives on **D:** so truth travels with the corpus (R21/R34) and is backed
up (R41). It reuses B0's mechanics verbatim: one JSON object per line, `prev = sha256(previous raw
line)[0..16]`, state is `fold(events)`, writers degrade rather than raise (G0's non-blocking rule).

Every event carries the **bi-temporal + provenance envelope** (§5.1): `valid_time` (when true in the
world) and `txn_time` (when recorded) — R1; an **HLC** stamp for skew-tolerant cross-machine causal
ordering (steer 7 — R11); `time_confidence` (`known` | `inferred`, steer 8 — R2/R3); `sid` +
`authorship` (`human` | `frontier` | `house`, R38) captured at capture time; `schema_version` on
every record (steer 10 — R32); and the `prev` chain hash. Corrections are **new events with new
`txn_time`**, never mutations (R3/R5); "what was true / what did we know at T" are both answered by
folding with a `valid_time ≤ T` / `txn_time ≤ T` predicate (R2). Full lineage is reconstructable from
the log alone (R7). Privacy deletions are **tombstone events** (moved+journalled, reversible — R6),
consistent with teleport.

- **Projection is where the stores get rebuilt** and where governance is enforced: each projector
  folds the KEL (optionally from a slice) applying (a) versioned up-converters `converters/<from>→<to>`
  for any record below current `schema_version` (steer 10, keeps old events replayable — R32);
  (b) the **leak gate + quarantine filter** so teleported sids never enter any projection at any point
  in time (R4/R31); (c) **keep-both-and-flag** on semantic conflict — two events asserting
  contradictory facts at the same `valid_time` are BOTH projected with a `conflict` marker and a
  `conflict_flagged` review event; the projector **never auto-picks** (steer 9). Rebuild-from-log is
  the R32 replay guarantee and the R36 additivity escape hatch (a new projector is additive, never
  breaks the default path).

### 4.2 Portable staging substrate on D: — full hybrid  · R17–R21, R40, R41

Per steer 2, three ideas composed, not chosen between:
- **CAS blob store** `blobs/<algo>/<hh>/<hash>` — content-addressed, so identity = hash and the same
  session synced from two machines de-dups to one blob (R20); append-only (R5).
- **Human-navigable index** `index/<machine>/<date>/<sid>.json` — thin pointer records (machine,
  process/agent, project/task context, sid ↔ card/concept links → R19) into the blobs; a person can
  browse by machine and date without a tool.
- **Self-describing manifest** `manifests/<machine>.json` — lets the drive attach to any machine and
  the pipeline resume with **no per-machine config** (R18); no machine need be online (R20), no
  LAN/desktop dependency, offline-capable (R21).

**R40 inbound poison gate** — a trust boundary *symmetric to the outbound leak gate*: staged raw
passes an integrity/validation gate (schema-well-formed, hash matches content, size/shape sane, no
injected control records) **before** it is admitted to synthesis or training, so a corrupt/injected
session on one machine cannot flow into the corpus. **R41 durability** — staging + KEL are
replicated to a second local target with periodic checksum integrity checks and a **restore drill**
(a copy, not a cloud service — stays local-first).

### 4.3 Delta engine — per-content-hash watermarks  · R8–R11, R32

Steer 3: the finest grain. A **cursor record** `(stage, input_content_hash, code_commit,
config_hash) → done` lives in the KEL / execution register. A stage processes an input only if no
`done` cursor exists for that tuple; unchanged content at the same code+config is **never
reprocessed** (R8), and re-running is idempotent (R10 — the cursor makes it a no-op). Deltas
propagate **incrementally** — a changed session touches only the affected cards/edges/rows/eval
slices, not a full rebuild (R9), by walking the KEL lineage edges of the changed blob. Out-of-order
arrival across machines is tolerated because **valid-time (HLC) resolves true sequence** at
projection, independent of arrival order (R11). Interrupted runs resume from the last durable cursor
(R10, extends LONGVIEW `--delta` + phase isolation).

### 4.4 Execution register — unified, backfilled  · R12–R16, R33, R37

Steer 4: one queryable **execution store** — a **JSONL projection on D:** (`executions.jsonl`),
folded exactly like every other log (§4.0 doctrine), rebuildable and therefore a projection not truth
(consistent with steer 1). It **folds four existing sources into one schema** (§5.4): G0
`runs/<id>/events.jsonl`, the EP-T train-result JSONs, the LONGVIEW ledger, and the B0 coordination
ledger — plus KEL lineage. **Backfilled once** from history so R16 cross-machine comparability is
immediate ("same task, model A on machine X vs model B on machine Y — cost/quality delta"). Every
execution (ingest, synthesis phase, dataset build, train, eval, merge, serve, offload, agent task) is
a first-class record (R12) config-tagged with model+version/hash, hardware
(machine/GPU/arch/VRAM/driver/ROCm/RAM), code commit, dataset/knowledge watermark, hyperparameters
(R13); metrics wall-time/tokens/cost/util/quality (R14, R37); and lineage + ledger links for
audit-without-tribal-knowledge (R15/R33). Rebuildable from the four logs = R32 replay.

**Why JSONL, not a database:** the register is a rebuildable cache whose truth is the four source
logs, so it needs no ACID/transactions (single-writer rebuild), no concurrent-writer store, and no FK
enforcement (lineage joins fold in memory). JSONL keeps **one storage grain, one schema-evolution
story** (the steer-10 converter registry — no parallel SQL migrations), stays human-readable and
page-corruption-recoverable on D: (R41), and adds no database to a deliberately file-based repo
(the §4 "reuse, don't rebuild" mandate). **DuckDB is the measure-first escape hatch, not the
default:** only if R16 analytical-query latency at real corpus scale is *measured* too slow do we
materialize an index — and DuckDB reads the JSONL in place (`SELECT … FROM 'executions.jsonl'`), so
the index is a near-free additive cache that never forks the storage format. Decided on a number,
not upfront — the EP-T "ship on a number, not a claim" ethos.

### 4.5 The closed loop + cross-machine orchestration  · R22–R30, R43, steers 5/6

A **`flywheel-daemon`** advances staged → synthesis → dataset → train → serve → agents → sessions
(R22), each hand-off automatable and gated (R27 board contracts). Trigger is **hybrid** (steer 5):
an fs-watch on `D:\flywheel-staging` fires reactively; a cron **sweep** is the backstop. **Both paths
are mutually exclusive across machines by reusing B0 unchanged** — before any mutating stage the
daemon must win a `leases/flywheel-turn.json` via the atomic `wx` create; the filesystem picks
exactly one winner and losers walk away (R43 exactly-once, R28/R29 concurrent machines, no new
mutual-exclusion mechanism invented). Each turn is **measured against the frozen EP-T instrument**
(R23) — no turn ships on a claim, only on a number; a non-improving turn is **logged, not hidden**,
rubrics stay frozen (R24). The **method-in-weights / facts-in-RAG** split is preserved end-to-end
(R25). Optimization targets are **explicit + versioned** records (R30). Compound value is the
**triad shown together** (steer 6 — R26): held-out eval delta (honest anchor) + agent pass-rate +
cost/task, over loop turns, on the existing ledger-sourced dashboard — never one gameable composite.

### 4.6 Liveness & the loop's safety guards  · R35, R38, R39, R44, R45, steer 11

The loop is where *self-learning* lives, so the sharp guards live here:
- **Liveness — full hybrid** (steer 11, R35): the daemon runs a **watchdog** on artifacts / CPU-time
  / mtime (never log lines — encodes [[verify-gpu-job-liveness]] and the `house-trainer` wedge
  lesson), an **external supervisor** heartbeat cross-check (a second tiny process, or B1, watches
  the lease heartbeat), and a **dead-man clean abort** — on wedge: `Stop-Process` the job, release
  the lease, emit `run_failed`, alert; **fail clean, never wedge the box**.
- **R38 model-collapse guard:** authorship is captured at staging/execution (wave 1, §4.1). At the
  dataset boundary (wave 3, extends `build_dataset.mjs`): a house-authored session becomes a training
  row **only after a verifier gate pass** (frozen rubric or frontier sign-off), and house-origin rows
  are **fraction-capped** per training turn — the loop trains on *validated method*, never raw
  self-output (extends R24/R25; this is the guard that makes §8 dogfooding safe from turn one).
- **R39 human-signed promotion + rollback:** wave 1 **records** the served-model pointer and what it
  replaced (a signed `served` record, §5.5); wave 3 the promotion **gate** requires a human signature
  (W0 `authority: human-signed`) — never an auto-swap on a passing number — and supports **pin +
  rollback**. "N+1 ≥ N" is an explicit **decision function** over the metric vector (eval NLL / agent
  pass-rate / cost / latency) with a stated Pareto-tradeoff rule (**R44**), so "better" is decided by
  rule, not relitigated. The held-out instrument grows **additively** — new slices added without
  invalidating the historical cross-turn series (**R45**, reconciles frozen-for-honesty with
  saturation).

### 4.7 Cross-cutting: privacy, additivity, provenance

Enforced structurally, not by convention: the **leak gate + quarantine apply at every boundary** —
staging (R40 inbound), each projection, dataset, training, serving — and bi-temporal history honors
quarantine (teleported sids excluded across all time-travel, R4/R31). Every capability is **additive**
(new projector, new phase, candidate engine) and never breaks the current default path (R36, extends
the T4 additive-router principle). Every derived artifact traces to source sessions + the execution
that produced it (R33 OpenLineage-complete, via §4.4). **R42 compaction budget:** append-only on a
finite drive gets a stated storage budget + archival + **journalled (additive) compaction** so growth
and capacity do not collide silently.

### 4.8 Requirement → component map

| Component (§) | Satisfies |
| --- | --- |
| Knowledge event log (4.1) | R1–R7, R11, R32, R36; steers 1,7,8,10 |
| Portable staging + poison gate + durability (4.2) | R17–R21, R40, R41; steer 2 |
| Delta engine (4.3) | R8–R11 |
| Execution register (4.4) | R12–R16, R33, R37; steer 4 |
| Loop orchestration + claim (4.5) | R22–R30, R43; steers 5,6 |
| Liveness + safety guards (4.6) | R35, R38, R39, R44, R45; steer 11 |
| Cross-cutting privacy/additivity/compaction (4.7) | R4, R31, R33, R36, R42; steer 9 |

## 5. Schema / DDL

All shapes are **additive-default + `schema_version`-tagged** (steer 10) and reuse the B0/G0 envelope
conventions (`prev` chain hash where truth, one object per line) — one storage grain across the whole
substrate, no database (see §4.4). Projections (execution register, stores) are rebuildable from the
logs.

### 5.1 Knowledge event log — envelope (`kel-event.schema.json`)

```
D:\flywheel-staging\eventlog\<yyyy>\<mm>\events-<hlc-day-bucket>.jsonl   # append-only, chain-hashed
```
```jsonc
{
  "id": "01J…",                    // ULID, event identity
  "schema_version": "1.0.0",        // steer 10 — every record tagged
  "type": "card_asserted",          // see event types below
  "valid_time": "2026-07-22T14:03:00Z",   // when true in the world (R1)
  "txn_time":   "2026-07-25T09:11:04Z",   // when recorded (R1); corrections = new event, new txn_time (R3)
  "time_confidence": "known",       // known | inferred  (steer 8 — inferred ⇒ valid_time=txn_time)
  "hlc": "2026-07-25T09:11:04.008Z-0007-mX",  // wall-logical-node — causal order across machines (steer 7, R11)
  "machine": "t480",                // R13/R19
  "authorship": "house",            // human | frontier | house  (R38, captured at capture time)
  "sid": "sess_…",                  // identity join to memo-ray/cards/quarantine (R4)
  "subject": { "kind": "card", "id": "…", "content_hash": "sha256:…" },  // what this event is about
  "payload": { … },                 // type-specific (additive)
  "supersedes": ["<event-id>", …],  // versioning link, never deletion (R3/R5)
  "prev": "9f2c…"                   // sha256(previous raw line)[0..16]; "genesis" for first (B0 rule)
}
```
- **Event types:** `session_staged`, `card_asserted`, `entity_asserted`, `edge_asserted`,
  `concept_merged`, `dataset_row_derived`, `model_recorded`, `execution_recorded`, `cursor_advanced`
  (delta), `conflict_flagged` (steer 9), `tombstoned` (R6 privacy), `schema_migrated`. Unknown fields
  permitted; missing required fields rejected (G0 rule). No event may assert a `subject.content_hash`
  absent from the CAS store (§5.2) — the R40/R7 integrity guard.
- **Confidence flag** (`time_confidence`) is mandatory so backfill never fabricates precision (steer 8).

### 5.2 CAS staging + index + manifest  · steer 2, R17–R20

```
D:\flywheel-staging\
├── blobs\<algo>\<hh>\<full-hash>            # e.g. blobs\sha256\9f\9f2c… ; identity=hash, de-dup (R20)
├── index\<machine>\<yyyy-mm-dd>\<sid>.json  # human-navigable pointer (below)
└── manifests\<machine>.json                 # self-describing, plug-and-play (R18)
```
```jsonc
// index/<machine>/<date>/<sid>.json  — thin pointer, R19 machine/process/context/knowledge aware
{ "sid": "sess_…", "machine": "t480", "process": "claude-code|antigravity|agent:<id>",
  "project": "prime-silo", "task_context": "EP-L/L4", "captured_at": "…", "valid_time": "…",
  "blobs": ["sha256:9f2c…"], "authorship": "house",
  "links": { "cards": ["…"], "concepts": ["…"] }, "poison_gate": "pass", "schema_version": "1.0.0" }

// manifests/<machine>.json  — R18 the drive attaches anywhere with no per-machine config
{ "machine": "t480", "hardware": { "gpu": "gfx1200", "vram_gib": 15.92, "rocm": "7.13.0" },
  "hlc_node_id": "mX", "staging_root": "flywheel-staging", "kel_root": "eventlog",
  "last_hlc": "…", "backup_target": "…", "schema_version": "1.0.0" }
```

### 5.3 Delta cursor  · steer 3, R8–R10

A `cursor_advanced` KEL event (also folded into the register). Per-content-hash grain:
```jsonc
{ "type": "cursor_advanced", "stage": "graph",
  "key": { "input_content_hash": "sha256:…", "code_commit": "abc123", "config_hash": "sha256:…" },
  "status": "done", "run_id": "…", "outputs": ["sha256:…"], "schema_version": "1.0.0" }
```
A stage skips any input whose `(input_content_hash, code_commit, config_hash)` already has a `done`
cursor (idempotent/resumable — R10); unchanged content is never reprocessed (R8).

### 5.4 Execution register — unified JSONL projection (`D:\flywheel-staging\executions.jsonl`)

Rebuildable projection folding G0 events + train JSONs + LONGVIEW ledger + B0 ledger + KEL lineage
(steer 4); backfilled once (R16). One record per execution, additive fields only (steer 10). Same
envelope discipline as the other logs; `lineage` is inlined (folded from `artifact_*` events) rather
than a separate table — it folds in memory, no join engine needed.
```jsonc
{ "exec_id": "01J…",                    // ULID
  "kind": "train",                      // ingest|synthesis|dataset|train|eval|merge|serve|offload|agent
  "run_id": "…",                        // → runs/<run_id>/events.jsonl (G0)
  "valid_time": "…", "txn_time": "…", "hlc": "…",
  "machine": "t480",                    // R13/R16 cross-machine key
  "config": {                           // R13 config tag
    "model_id": "house/qwen2.5-coder-tuned", "model_hash": "sha256:…", "code_commit": "abc123",
    "hw": { "gpu": "gfx1200", "arch": "RDNA4", "vram_gib": 15.92, "driver": "…", "rocm": "7.13.0", "ram_gib": 32 },
    "knowledge_watermark": "sha256:…",  // bi-temporal hash/cursor of inputs (R13/R32)
    "hparams": { … } },
  "metrics": {                          // R14/R37
    "wall_ms": 6012000, "tokens_in": …, "tokens_out": …, "cost_est": 0.0,
    "gpu_util": 0.94, "ram_peak_gib": 14.1,
    "quality": { "loss": …, "eval_nll": 1.1253, "judge": 1.0, "gate_pass": true } },
  "lineage": { "inputs": ["sha256:…"], "outputs": ["sha256:…"] },  // R33, folded from artifact_* events
  "authorship": "house",                // R38
  "source_log": "train-json",           // which of the 4 logs this record folded from (provenance)
  "schema_version": "1.0.0" }
```
- **R16 query** ("same task, model A on machine X vs model B on machine Y") = filter on
  `kind` + `machine` + `config.model_id`, compare `metrics`. Fold-and-filter in the dashboard at
  expected scale; **DuckDB `SELECT … FROM 'executions.jsonl'`** is the additive fallback if that fold
  is *measured* too slow (§4.4) — no format change, the JSONL stays the store.

### 5.5 Served-model pointer + promotion record  · R39, R44

```jsonc
// served-model pointer (signed) — R39 record-what-is-served + how to revert
{ "type": "model_promotion", "served": "house/qwen2.5-coder-tuned", "replaces": "house/…-prev",
  "decision_vector": { "eval_nll": 1.1218, "agent_pass": 0.86, "cost_per_task": 0.0, "latency_ms": 1900 },
  "decision_rule": "dominates-or-pareto-with-eval-anchor",   // R44 explicit rule, not relitigated
  "human_signature": "<owner-sig>", "rollback_to": "house/…-prev",   // pin+rollback
  "valid_time": "…", "txn_time": "…", "schema_version": "1.0.0" }
```
Held-out instrument growth (R45): eval slices carry `added_in_turn`; the cross-turn series compares
only slices present in both turns, so new slices extend without invalidating history.

### 5.6 Shared field specs

- **HLC** (steer 7): `<wall-ISO>-<logical-counter-4hex>-<node_id>`; on receive, `wall = max(local,
  remote, prev)`, bump logical on tie — standard HLC. Node id from `manifests/<machine>.json`.
- **schema_version** (steer 10): semver; a bump with a breaking change ships a
  `converters/<from>→<to>.mjs` applied at projection so old events stay replayable (R32).
- **time_confidence** (steer 8): `known` uses the real timestamp; `inferred` sets
  `valid_time = txn_time` and flags low-confidence — never fabricated precision.

## 6. Task breakdown — delivery-board work contracts (EP-L)

New epic **`EP-L` — LONGVIEW flywheel (self-learning substrate)**, Objective **O1/O2**, sequenced
onto the §7 waves. Contracts follow `SPEC-work-contracts` (red-first `verify` gate; `author≠verifier`;
`allowlist`; `deps` = `plan-deps.json`; each id in exactly one `TRACEABILITY.md` row). Full
board-ready files are authored into `delivery/tasks/L*.md` at plan checkpoints (opus, per the
delivery-board skill); this table is the design-level breakdown + dependency graph. Milestone **M4**.
_(Authoring note, 2026-07-25: the wave-1 spine L0–L7 is now authored to the board — `delivery/epics/EP-L.md`,
`delivery/milestones/M4-flywheel.md`, `delivery/tasks/L0–L7.md`, the `TRACEABILITY.md` row, and
`plan-deps.json`. The `w0` validator's milestone enum was additively bumped `…|M3` → `…|M3|M4` **at
authoring time** — not deferred into L0 as first sketched, since 8 `M4` contracts would otherwise red
the gate on arrival; so L0's allowlist no longer carries `validate.mjs`. `node scripts/gates/w0.mjs` is
GREEN with 74 contracts.)_

| id | wave | title (goal in one line) | deps | authority | verify gate | Rs |
| --- | --- | --- | --- | --- | --- | --- |
| **L0** | 1 | **KEL spec + validator** — envelope schema, chain-hash, fold-to-state, converter registry; reuse B0 mechanics | — | human-signed | `node scripts/gates/l0.mjs` | R1–R7,R11,R32 |
| **L1** | 1 | **CAS staging + manifest + index** on D: (blobs/index/manifests), de-dup, plug-and-play | L0 | human-signed | `node scripts/gates/l1.mjs` | R17–R21 |
| **L2** | 1 | **Inbound poison gate** — integrity boundary symmetric to leak gate, at admission | L1 | agent-ok | `node scripts/gates/l2.mjs` | R40 |
| **L3** | 1 | **Durability** — replicate staging+KEL, checksum integrity check + restore drill | L1 | human-signed | `node scripts/gates/l3.mjs` | R41 |
| **L4** | 1 | **Delta engine** — per-content-hash cursors, idempotent/resumable, HLC ordering-tolerant | L0 | agent-ok | `node scripts/gates/l4.mjs` | R8–R11 |
| **L5** | 1 | **Execution register** — unified `executions.jsonl` projection + backfill of the 4 logs (DuckDB fallback deferred, measure-first) | L0,L4 | agent-ok | `node scripts/gates/l5.mjs` | R12–R16,R33,R37 |
| **L6** | 1 | **Authorship + record-served tagging** at capture time (human/frontier/house; served pointer) | L0,L5 | agent-ok | `node scripts/gates/l6.mjs` | R38(tag),R39(record) |
| **L7** | 1 | **Single-winner loop claim + compaction budget** — reuse B0 `wx` lease for `flywheel-turn`; storage/compaction policy | L0,B0 | agent-ok | `node scripts/gates/l7.mjs` | R43,R42 |
| **L8** | 2 | **Bi-temporal projectors** — rebuild Neo4j/Chroma/memo-ray/cards from KEL; time-travel query (valid/txn) | L0,L4 | agent-ok | `node scripts/gates/l8.mjs` | R1–R3,R7,R32 |
| **L9** | 2 | **Privacy-honoring history** — leak/teleport filter + keep-both-and-flag conflict at projection, across all time | L8 | human-signed | `node scripts/gates/l9.mjs` | R4,R6,R31,steer9 |
| **L10** | 3 | **flywheel-daemon** — file-watch + cron backstop; watchdog+supervisor+dead-man liveness | L7,L8 | human-signed | `node scripts/gates/l10.mjs` | R22,R28,R29,R35 |
| **L11** | 3 | **Model-collapse guard** — verifier gate + house-fraction cap in `build_dataset.mjs` | L6,L10 | human-signed | `node scripts/gates/l11.mjs` | R38 |
| **L12** | 3 | **Human-signed promotion + rollback** gate on the served position; pin/revert | L6,L10 | human-signed | `python scripts/gates/l12.py` | R39 |
| **L13** | 3 | **Promotion decision function + eval additive growth** — dominance/Pareto rule; slice `added_in_turn` | L12 | human-signed | `node scripts/gates/l13.mjs` | R44,R45 |
| **L14** | 3 | **Compound-value triad dashboard** — eval-delta + agent pass-rate + cost/task over turns | L5,L10 | agent-ok | `node scripts/gates/l14.mjs` | R23,R24,R26,R30 |

Dependency graph is acyclic: wave-1 spine `L0 → {L1,L4}`, `L1 → {L2,L3}`, `{L0,L4} → L5 → L6`,
`{L0,B0} → L7`; wave-2 `{L0,L4} → L8 → L9`; wave-3 `{L7,L8} → L10 → {L11,L12} `, `L12 → L13`,
`{L5,L10} → L14`. The wave-1 spine is the R17 "stage raw to D: now" quick win plus its guards.

**Two exemplar contracts** (the rest follow this shape when authored into `delivery/tasks/`):

```yaml
# delivery/tasks/L0.md
id: L0
epic: EP-L
milestone: M4
okr: O2.KR2.2            # extends the "one honest stream" instrument to knowledge truth
deps: []
authority: human-signed  # the truth substrate's schema is a foundational, human-signed decision
allowlist: [architecture/SPEC-knowledge-eventlog.md, server/coordination/schema/kel-event.schema.json,
  server/coordination/lib/kel.mjs, tests/kel/, scripts/gates/l0.mjs]  # validate.mjs enum bump done at authoring time
tools: [node]
sandbox: worktree
verify: node scripts/gates/l0.mjs
budget: 400
```
```gherkin
# L0 ## Acceptance
Feature: the knowledge event log is truth; stores are projections
  Scenario: a correction never mutates history
    Given a card_asserted event E1 at txn_time T1
    When a card_asserted event E2 supersedes E1 at txn_time T2
    Then folding at txn_time T1 still yields E1 and folding now yields E2, and E1's raw line is unchanged
  Scenario: the chain betrays an edited historical line
    Given a KEL with N appended events
    When any historical line is edited
    Then the validator reports the 1-based line number whose prev-hash no longer matches
  Scenario: an out-of-version record still replays
    Given an event at schema_version 1.0.0 and a converter 1.0.0→1.1.0
    When the projector rebuilds
    Then the event is up-converted and projected without error
```
```yaml
# delivery/tasks/L2.md
id: L2
epic: EP-L
milestone: M4
okr: O2.KR2.2
deps: [L1]
authority: agent-ok
allowlist: [server/coordination/lib/poison_gate.mjs, scripts/longview/lib/leak_gate.mjs, tests/poison/, scripts/gates/l2.mjs]
tools: [node]
sandbox: worktree
verify: node scripts/gates/l2.mjs
budget: 300
```
```gherkin
# L2 ## Acceptance
Feature: an inbound integrity boundary symmetric to the outbound leak gate
  Scenario: a hash-mismatched blob is refused admission
    Given a staged session whose content does not hash to its declared content_hash
    When the poison gate runs at admission
    Then the session is rejected and never emitted as a session_staged KEL event
  Scenario: an injected control record cannot pose as data
    Given a staged blob carrying a forged KEL control event
    When the poison gate runs
    Then it is rejected as non-data and the rejection is ledgered
```

## 7. Phasing (from requirements §8 + §9.5 — design sequences tasks onto these)

1. **Wave 1 — substrate:** R17–R21 staging + R8–R11 delta + R12–R16 execution tagging, **plus the
   Tier-1 guards slotted here (§9.5):** R40 poison gate + R41 durability with staging; R38 authorship
   *tagging* + R39 *record-served* at capture time; R42/R43 (storage/compaction, single-winner claim).
2. **Wave 2 — bi-temporal + additive knowledge:** R1–R7 over the substrate; time-travel; privacy-
   honoring history.
3. **Wave 3 — closed loop + agent loops:** R22–R30; the R38 fraction-cap+verifier gate and R39
   promotion gate *activate* here; R44/R45 (multi-metric promotion rule, additive eval growth); the
   compound-value dashboard (R26).

## 8. Delivery doctrine (how this gets built — from requirements §9.4)

Dogfood the flywheel to build it: **house model carries the high-volume specified work** (synthesis
phases, dataset/delta builds via `house-trainer`/`longview-pipeline`); **frontier sessions carry
design, gate-writing, and verification**. Capture every session with authorship tags (R38); only
frontier-verified house sessions enter training (R38+R44); track the house-carried fraction per loop
turn as an explicit optimization target (R30). This delivery *is* wave-3 behavior exercised early —
so R38's guard is in force from the first house-authored session, not deferred.

---

*Design authored 2026-07-25 (claude-opus). §4–§6 are written against the §2/§3 owner steers and
trace to R1–R45; §1/§7/§8 are the mandate they work within. **Next steps:** owner review of the
design itself; then author the wave-1 spine (L0→L1→{L2,L3,L4}→L5→L6, L7) as full
`delivery/tasks/L*.md` contracts + `EP-L.md` epic + `TRACEABILITY.md` row + `plan-deps.json` /
w0-milestone additive bump, and stage this design session as house/frontier-tagged training material
per §8. Two contracts (L0, L2) are drafted inline in §6 to seed that authoring.*

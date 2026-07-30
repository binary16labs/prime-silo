# Requirements — LONGVIEW → a self-learning system (the flywheel)

**Status:** DRAFT for owner review. Requirements only — **solution design and tasks are for a
separate session** (per owner instruction). Nothing here prescribes _how_; it states _what the
system must do_ and _why_, with numbered requirements (R#) the design session can trace to.

**Author:** claude-opus, 2026-07-25, at the close of EP-T (KR1.5). **Reviewer:** owner.

---

## 1. Objective

Turn the pieces we now have into **one compounding loop**: work sessions (on many machines)
become synthesized knowledge, which becomes training data, which becomes a better local model,
which powers better agents, which produce better sessions — and **every turn of the loop is
measured so we can prove it improves**. The whole must be worth more than the sum of the parts:
a **true self-learning system** that gets better as we expand, not just a bigger pile of data.

> **The flywheel:**
> multi-machine sessions → staged raw (portable drive) → LONGVIEW synthesis (bi-temporal,
> additive, delta) → knowledge (cards / graph / vectors) → training dataset → tuned model →
> served behind the router → agents use it → better sessions → (repeat, measured each turn).

## 2. What we're standing on (the foundation — do not rebuild)

The design session should reuse, not replace, these proven components:

- **LONGVIEW** session-synthesis pipeline (ADR-005): inventory → extract → map → graph → enrich
  → reduce → opus/pdf. Deterministic v2 graph from card fragments; `--delta` runs; earned-ETA.
- **Stores:** memo-ray entity tree (sid-keyed Tool Call / Tool Result / Thought / User Input),
  Chroma vectors, Neo4j knowledge graph, LONGVIEW cards (JSON + markdown), rollups.
- **Governance & privacy:** memory teleport/quarantine (**moves, never deletes**), the leak gate
  (`lib/leak_gate.mjs`), sid-keyed everything.
- **Observability:** the ledger-sourced dashboard, OpenLineage lineage DAG, the **execution
  register** (per run: commit/model/phases/outcome/cost).
- **EP-T training pipeline (this session):** T2 dataset builder (leak-gated, delta-capable),
  T3 QLoRA + frozen-rubric eval, T5 DPO, T4 additive router candidate + ADR-004 offload gate,
  the `house-trainer` skill, the model itinerary.
- **Delivery board:** work contracts, red-first gates, **author≠verifier**, append-only LOG,
  the `w0` backlog validator — the control plane for agents.
- **Hardware reality:** T480 + RX 9060 XT eGPU (native-Windows ROCm), LM Studio serving, the
  portable **D:** drive already carrying `benny-home` + workspaces + merged GGUFs.

## 3. Scope

**In scope (requirements for):** a bi-temporal, additive, delta-driven knowledge+execution
substrate; orchestration/execution tagging with config + metrics + observability; multi-machine
raw-session staging on the portable drive with plug-and-play awareness; the closed self-learning
loop and its measurement; agent loops that run and optimize the pipeline.

**Out of scope (here):** the solution design, the schema/DDL, the task breakdown, any code — all
deferred to the design+tasks session. Also out: replacing the model/training method (EP-T stands),
and any cloud dependency (local-first remains a hard constraint).

---

## 4. Functional requirements

### 4.1 Bi-temporal knowledge model

- **R1.** Every knowledge record (session, card, entity, concept, graph edge, dataset row,
  model, execution) SHALL carry **two time axes**: **valid-time** (when it was true in the world
  — e.g. when the session ran, when a decision was made) and **transaction-time** (when the
  system recorded/derived it).
- **R2.** The system SHALL answer both **"what was true at time T"** (valid-time) and **"what did
  we _know_/record at time T"** (transaction-time), including reconstructing the exact knowledge
  state that produced any given artifact (e.g. the corpus a model was trained on).
- **R3.** Corrections SHALL create **new versions** with new transaction-time, never mutate or
  erase prior versions (see Additive). A record's history SHALL be fully recoverable.
- **R4.** Bi-temporal keys SHALL compose with the existing **sid** identity and the
  quarantine/teleport filters so time-travel queries respect privacy exclusions.

### 4.2 Additive / non-destructive

- **R5.** All writes SHALL be **append-only**. No pipeline stage may destroy or overwrite prior
  knowledge; supersession is expressed as a new version + a link, not deletion (extends the
  existing "moves, never deletes" teleport model).
- **R6.** Deletions required for privacy/compliance SHALL be **tombstoned + quarantined** (moved,
  journalled, reversible), never hard-erased, consistent with the leak-gate/teleport doctrine.
- **R7.** The full lineage of any artifact SHALL be reconstructable from append-only records
  alone (no reliance on mutable state).

### 4.3 Delta-driven incremental processing

- **R8.** Every stage SHALL process **only what changed** since its last run, keyed by a durable
  per-source **watermark/cursor** and **content-addressed hashes** of inputs (so re-running is
  cheap and idempotent, and unchanged inputs are never reprocessed).
- **R9.** Deltas SHALL propagate **incrementally** through the graph, vectors, dataset, and eval —
  a new/changed session updates only the affected cards/edges/rows, not a full rebuild.
- **R10.** The system SHALL be **idempotent and resumable**: an interrupted or duplicated delta
  run converges to the same state (extends LONGVIEW `--delta` + phase-isolation).
- **R11.** Delta application SHALL be **ordering-tolerant** across machines (sessions may arrive
  out of order from different machines; bi-temporal valid-time resolves the true sequence).

### 4.4 Orchestration & execution tagging (config + metrics + observability)

- **R12.** Every **execution** (any pipeline run: ingest, synthesis phase, dataset build, train,
  eval, merge, serve, offload task, agent task) SHALL be a **first-class, queryable record** in
  the execution register, extending the existing register + OpenLineage lineage + delivery LOG.
- **R13.** Each execution record SHALL be **config-tagged** with at minimum: **model** (id +
  version/hash), **hardware** (machine id, GPU/arch/VRAM, driver/ROCm versions, host RAM), code
  **commit**, **dataset/knowledge version** (bi-temporal watermark or hash), and hyperparameters.
- **R14.** Each execution SHALL record **performance metrics**: wall time, tokens, cost estimate,
  GPU/CPU/RAM utilization where available, and stage-specific quality numbers (loss, eval NLL,
  judge scores, gate pass/fail).
- **R15.** Executions SHALL be **fully observable**: linked logs, lineage edges (inputs→outputs),
  and a human-readable ledger entry — enough to reproduce or audit the run without tribal
  knowledge. (Builds on the dashboard + lineage DAG + execution register.)
- **R16.** The system SHALL make execution records **comparable across machines and time** so we
  can ask e.g. "same task, model A on machine X vs model B on machine Y — cost/quality delta".

### 4.5 Multi-machine + portable-drive staging (plug-and-play)

- **R17.** Raw session data (Claude / Antigravity / agent traces, memo-ray entities) from **every
  machine** SHALL be **staged on the portable drive** in a **machine-tagged, content-addressed,
  append-only staging area** — the single point of truth for un-synthesized raw input.
  _(Directly answers the owner's question: yes — stage raw to the portable drive now.)_
- **R18.** Staging SHALL be **self-describing**: a manifest lets the drive attach to any machine
  and the pipeline resume with no per-machine configuration — **plug-and-play**.
- **R19.** Each staged session SHALL be **machine-aware, process-aware, context-aware, and
  knowledge-aware**: it carries which machine and which agent/process produced it, the project/task
  context, and links into the knowledge graph (sid ↔ concepts/cards).
- **R20.** Ingestion SHALL **de-duplicate** across machines (the same session synced twice is
  ingested once) via content-addressing, and SHALL never require a specific machine to be online
  (no hard LAN/desktop dependency — extends the T1 self-sufficiency property).
- **R21.** The staging + knowledge substrate SHALL remain **local-first and offline-capable**;
  the portable drive is the transport between machines, not a cloud service.

### 4.6 The self-learning loop (closed feedback)

- **R22.** The system SHALL implement a **closed loop**: staged sessions → synthesis → dataset →
  train → serve → agents → new sessions, with each hand-off automatable and gated.
- **R23.** Each loop turn SHALL be **measured against a frozen instrument** (the EP-T held-out
  eval + agent success/cost metrics) so **improvement is provable** — model N+1 ≥ model N, or the
  regression is flagged. No turn ships on a claim; every turn ships on a number.
- **R24.** The loop SHALL support **honest negative results** (a turn that doesn't improve is
  logged, not hidden; rubrics are frozen, never tuned to pass — the EP-T doctrine).
- **R25.** The loop SHALL preserve the **method-in-weights / facts-in-RAG** split: synthesis feeds
  _method/voice/tool-use_ to training and _facts_ to RAG; no fact-cramming.
- **R26.** **Compound value SHALL be measurable end-to-end**: a dashboard view proving the flywheel
  (sessions↑ → knowledge coverage↑ → eval↑ → agent success↑ / cost↓) over time, not just
  per-component metrics.

### 4.7 Agent loops & optimization

- **R27.** Relevant pipeline stages SHALL be delivered as **agent-runnable tasks** on the delivery
  board (work contracts + red-first gates + author≠verifier), so agents can run the whole workflow
  without frontier supervision (extends the existing board + `house-trainer`/`longview-pipeline`
  skills).
- **R28.** Agents SHALL run in **loops** (triggered by new staged sessions or on a schedule) that
  advance the flywheel and **self-optimize**: each cycle either improves a measured number or
  raises a flagged regression for review.
- **R29.** The system SHALL support **many machines running sessions concurrently**, feeding one
  shared bi-temporal substrate via the portable staging, with agents on any machine able to pick
  up board tasks.
- **R30.** Optimization targets SHALL be **explicit and versioned** (e.g. maximize held-out eval,
  minimize offload cost, maximize agent task pass-rate) so "optimize" is measurable, not vibes.

---

## 5. Non-functional requirements

- **R31. Privacy (hard):** the leak gate + quarantine SHALL apply at **every** boundary
  (staging, synthesis, dataset, training, serving). Job-application/CV/personal content NEVER
  enters knowledge or training. Bi-temporal history SHALL honor quarantine (teleported sids stay
  excluded across all time-travel).
- **R32. Determinism & reproducibility:** given the same inputs + config, a stage SHALL produce
  the same output; any execution SHALL be replayable from its config-tag + bi-temporal watermark.
- **R33. Provenance:** every derived artifact SHALL trace to its source sessions and the execution
  that produced it (OpenLineage-complete).
- **R34. Portability / sovereignty:** local-first, no absolute-path assumptions, runs off the
  portable home (extends T1 + the `${BENNY_HOME}` rule); no cloud dependency for the core loop.
- **R35. Observability-by-default:** no silent stages; every run is ledgered and dashboard-visible;
  liveness is provable (CPU/artifacts, not log-appearance — the lesson from the DPO session).
- **R36. Additivity of change:** new capabilities SHALL be additive (candidate engines, new phases)
  and never break the current default path (extends the T4 additive-router principle).
- **R37. Cost/latency awareness:** executions SHALL record cost/latency so the loop can optimize
  for the sovereignty gradient (right model on right hardware for the job — see the model itinerary).

---

## 6. Open questions for the design session (decisions to make, not here)

1. **Bi-temporal storage:** extend Neo4j/memo-ray/Chroma with time axes, or introduce a
   dedicated bi-temporal event log (e.g. an append-only ledger the stores project from)? Trade-offs
   of "temporal columns on existing stores" vs "event-sourced projection".
2. **Staging format on D::** content-addressed blob store + manifest? one dir per machine per day?
   How to reconcile memo-ray's entity-per-file model with content-addressing + de-dup.
3. **Delta watermark granularity:** per-session, per-entity, or per-content-hash? Where cursors live.
4. **Execution-register schema:** unify the training result JSONs + delivery LOG + LONGVIEW ledger
   - lineage into one queryable execution store, or federate them behind a view?
5. **Loop trigger/orchestration:** what schedules the loop (file-watch on staging? cron? the
   coordination server B1?) and how agents claim work across machines without collision (extends
   the B0/B1 coordination ledger + exactly-one-winner claim race).
6. **Compound-value metric:** define the single headline number that proves the flywheel turns
   (candidate: held-out eval delta per loop + agent task pass-rate + cost/task).
7. **Multi-machine identity & clock:** machine ids, clock-skew handling for valid-time across
   machines (logical vs wall clocks).
8. **Backfill:** how to bi-temporally backfill the existing corpus (sessions_v1 etc.) without
   fabricating valid-times we don't have.

### 6.1 Owner steers — RESOLVED 2026-07-25 (binding for the design session)

All 11 open questions (§6 items 1–8 + §9.3 items 9–11) now have an owner decision. The design
session implements these; where a steer says "hybrid" the design session specs the composition.

1. **Bi-temporal storage → event-log-as-truth.** An append-only event log is the single source of
   truth; Neo4j / Chroma / memo-ray are **rebuildable projections** off it. (Purest fit for the
   additive + R32 replay doctrine.)
2. **Staging format on D: → full hybrid.** A content-addressed blob store provides storage +
   de-dup (hash = identity), with a **human-navigable machine/date index tree layered over it** and
   a self-describing per-machine manifest. All three ideas combined.
3. **Delta watermark → per-content-hash.** Finest grain; unchanged content never reprocessed.
   Cursors live in the event log / execution register.
4. **Execution register → unified schema, backfilled.** One queryable execution store; train-result
   JSONs + delivery LOG + LONGVIEW ledger + lineage **projected in and backfilled** for immediate
   R16 cross-machine comparability.
5. **Loop trigger → hybrid file-watch + cron backstop.** File-watch on D: staging triggers reactively;
   a scheduled cron **sweep** is the backstop. Both gated by the B0/B1 **single-winner claim** for
   cross-machine mutual exclusion (R43).
6. **Compound-value metric → the triad, shown together.** Held-out eval delta is the **honest anchor**;
   agent task pass-rate and cost/task ride alongside. The flywheel dashboard (R26) presents all three
   over time rather than collapsing to one gameable composite.
7. **Multi-machine clock → hybrid logical clocks (HLC).** Skew-tolerant causal ordering + human-
   meaningful wall time.
8. **Backfill → real-where-known, else inferred.** Use the session's real timestamp for valid-time
   where it exists; otherwise valid-time = transaction-time, **tagged inferred/low-confidence** (never
   fabricate precision). Requires a confidence flag on records.
9. **Semantic conflict → keep-both-and-flag.** Record both versions, mark the conflict, surface to a
   verifier/human; **never auto-pick** a winner. Additive, zero data loss.
10. **Schema evolution → additive-default + versioned converters.** Additive-only by default (add
    optional, never rename/remove); versioned up-converters for the rare breaking change so old
    records stay replayable. Every record schema-version tagged.
11. **Loop liveness → full hybrid.** Artifact / CPU-time / mtime **watchdog** (not log lines) +
    **external supervisor** heartbeat cross-check + **dead-man clean abort** with alert. Catches both
    slow-but-working and the eGPU hard-wedge — encodes the [[verify-gpu-job-liveness]] lesson.

## 7. Acceptance criteria for THIS requirements doc (definition of ready for design)

- [x] Owner has reviewed and each R# (**R1–R37** original + **R38–R45** reviewer addendum, §9) is
      **accepted** — accepted as a set on 2026-07-25 to proceed to design; any per-R# amendment can be
      raised during design.
- [x] The **11** open questions each have an owner steer — **RESOLVED, see §6.1** (2026-07-25).
- [x] Priority/phasing agreed: **wave 1** = R17–R21 staging + R8–R11 delta + R12–R16 execution
      tagging (the substrate); loop automation R22–R30 in wave 3 (see §8 + §9.5).
- [x] The §9.5 phasing steer is confirmed: **Tier 1 (R38–R41) slotted into wave 1** (R40/R41 with
      staging; R38 tagging + R39 record-served in wave 1, their gates in wave 3); Tier 2 R42/R43 wave 1,
      R44/R45 wave 3.
- [x] "Stage raw to the portable drive now" (R17) — **confirmed as a wave-1 quick win.**

> **Definition of ready: MET (2026-07-25).** All R# accepted, all 11 open questions steered (§6.1),
> phasing confirmed. This doc is **ready for the design session** — hand off via
> [`SOLUTION-longview-self-learning.md`](SOLUTION-longview-self-learning.md).

## 8. Suggested phasing (owner to confirm — not binding)

1. **Wave 1 — the substrate:** portable raw staging (R17–R21) + delta/watermark (R8–R11) +
   execution tagging (R12–R16). Makes multi-machine capture + reproducibility real. Low risk,
   high leverage; unblocks everything else.
2. **Wave 2 — bi-temporal + additive knowledge:** R1–R7 over the substrate; time-travel queries;
   privacy-honoring history.
3. **Wave 3 — the closed loop + agent loops:** R22–R30; the measured flywheel + the compound-value
   dashboard (R26).

---

## 9. Reviewer addendum — gaps (additive; nothing above is amended)

**Author of addendum:** claude-opus (reviewer), 2026-07-25. Added under the additive doctrine —
these extend §4/§5/§6, they do not mutate any prior R#. Owner to accept / amend / reject each,
same as R1–R37. Rationale: the substrate (waves 1–2) reads complete; these gaps are almost all in
**the loop** (wave 3) — the part that makes this _self-learning_ rather than a bigger pipeline, and
therefore where the sharp safety/correctness risks live.

### 9.1 Tier 1 — must-add (correctness/safety holes)

- **R38. Self-training contamination / model-collapse guard.** The training signal SHALL carry
  **authorship provenance** (human / frontier-model / house-model), and the loop SHALL bound the
  house-model's _own_ outputs as a fraction of any training turn. A house-authored session SHALL
  become a training row only after passing a verifier gate (frozen rubric or frontier sign-off) —
  the loop trains on _validated_ method, never raw self-output. Without this, the flywheel
  (sessions→train→model→sessions) drifts into distillation-of-self and collapses. Extends R24/R25.
- **R39. Human-signed model promotion + rollback.** Promotion of model N+1 to the served position
  behind the router SHALL require a **human signature** (per the human-signed-stops doctrine); it
  SHALL NOT auto-swap on a passing number alone. The system SHALL support **pinning and rollback**
  of the served model (record what N+1 replaced and how to revert). Extends R23/R36.
- **R40. Input integrity / poison gate on staged raw.** The leak gate (R31) is _outbound_ privacy
  only. Staged raw sessions arriving from many machines SHALL pass an **inbound integrity/validation
  gate** (a trust boundary symmetric to the leak gate) before synthesis or training, so a corrupted
  or injected session on one machine cannot flow into the corpus. Extends R17/R20/R31.
- **R41. Durability of the portable substrate.** R17 makes **D:** the single point of truth;
  append-only ≠ backed up. The staging + knowledge substrate SHALL be **backed up / replicated**
  with periodic **integrity checks (checksums) and a restore drill**, so single-drive failure does
  not lose the corpus. Extends R17/R21 (backup is a copy, not a cloud dependency — stays local-first).

### 9.2 Tier 2 — should-add

- **R42. Storage growth / compaction budget.** Append-only + bi-temporal + never-delete on a finite
  drive SHALL have a stated **storage budget, archival, and compaction policy** (compaction itself
  additive/journalled), so growth and drive capacity do not collide silently. Extends R5–R7.
- **R43. Exactly-once cross-machine work claiming.** Concurrent machines SHALL claim loop/board work
  under an **exactly-once (single-winner) protocol**; two machines SHALL NOT train/merge against the
  substrate simultaneously. (Promotes Open Q5's claim-race from a design choice to a requirement —
  it is a corruption-avoidance property, not a nicety.) Extends R29.
- **R44. Promotion decision function (multi-metric).** "N+1 ≥ N" (R23) SHALL be defined as an
  explicit **dominance/decision rule** over the metric vector (eval NLL, agent pass-rate, cost,
  latency), specifying the outcome when metrics trade off (Pareto case) — so "better" is decided by
  rule, not relitigated per turn. Extends R23/R30/R37.
- **R45. Eval-set evolution vs. frozen comparability.** The held-out instrument SHALL support
  **additive growth** (new held-out slices added without invalidating the historical cross-turn
  series), reconciling "frozen for honesty" (R24) with saturation as capability rises. Extends R23/R24.

### 9.3 Additional open questions for the design session

9. **Semantic conflict resolution.** R11 resolves _ordering_ via valid-time, but not two machines
   deriving _contradictory_ facts at the same valid-time. How is truth adjudicated (last-writer,
   confidence, human review, keep-both-and-flag)?
10. **Schema evolution across bi-temporal history.** R32 requires replay; evolving the
    card/graph/dataset schema over time makes old records un-replayable without versioned migration.
    How do schemas evolve additively while preserving replayability? (Relates to Open Q8 backfill.)
11. **Loop-level liveness.** Beyond per-run observability (R35), how is a _stalled agent loop_
    detected and alerted — not merely logged — given "a tqdm line ≠ alive" and the eGPU's transient
    wedging? (Dead-man switch / resource+thermal abort that fails clean rather than wedging the box.)

### 9.4 Delivery note — build the flywheel by dogfooding the flywheel

Per owner steer, deliver this item using the **house model as much as possible** and stage these
sessions as training material — but note this _is_ the self-training loop from turn one, so **R38 is
the guard that makes it safe**, not optional overhead. Suggested split (fits the existing board +
`author≠verifier`): house model (LM Studio/eGPU, `house-trainer`/`longview-pipeline`) carries the
high-volume specified work (synthesis phases, dataset/delta builds); frontier sessions carry
requirements/design/gate-writing/**verification**. Capture every session with authorship tags (R38);
frontier _corrections_ of house output are the highest-value method-in-weights signal (R25); only
frontier-verified house sessions enter training (R38+R44). Track the **fraction of delivery work the
house model carries per loop turn** as an explicit optimization target (R30) — that number rising
_while_ held-out eval holds or improves is the real proof of compounding (R26), not corpus size.

### 9.5 Phasing note (extends §8; owner to confirm)

The four **Tier 1** requirements are **wave-1 substrate concerns**, not wave-3 loop polish — they
guard the substrate the moment raw is staged and the first house-authored session appears, so they
should land alongside R17–R21 / R8–R11 / R12–R16:

- **R40** (inbound poison gate) and **R41** (drive durability/backup) — land **with** the staging
  substrate (R17–R21); staging without an integrity boundary or a backup is a wave-1 hole.
- **R38** (authorship provenance in the signal) — the _tagging_ is wave-1 (capture provenance at
  staging/execution time, alongside R12–R16); the _fraction cap + verifier gate_ activate in wave 3
  when the loop closes.
- **R39** (human-signed promotion + rollback) — wave-1 to the extent of **recording** what is served
  and how to revert; the promotion _gate_ itself is exercised in wave 3.

Tier 2 (R42–R45) tracks its natural wave: R42/R43 with wave-1 substrate, R44/R45 with wave-3 loop.

---

_Ends. Design + task breakdown are deliberately excluded — hand this to the design session. The
existing skills (`longview-pipeline`, `house-trainer`, `delivery-board`, `phase-runner`) and this
session's EP-T artifacts are the substrate that session should build on._

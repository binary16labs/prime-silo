# Requirements — LONGVIEW → a self-learning system (the flywheel)

**Status:** DRAFT for owner review. Requirements only — **solution design and tasks are for a
separate session** (per owner instruction). Nothing here prescribes *how*; it states *what the
system must do* and *why*, with numbered requirements (R#) the design session can trace to.

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
  we *know*/record at time T"** (transaction-time), including reconstructing the exact knowledge
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
  *(Directly answers the owner's question: yes — stage raw to the portable drive now.)*
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
  *method/voice/tool-use* to training and *facts* to RAG; no fact-cramming.
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
   + lineage into one queryable execution store, or federate them behind a view?
5. **Loop trigger/orchestration:** what schedules the loop (file-watch on staging? cron? the
   coordination server B1?) and how agents claim work across machines without collision (extends
   the B0/B1 coordination ledger + exactly-one-winner claim race).
6. **Compound-value metric:** define the single headline number that proves the flywheel turns
   (candidate: held-out eval delta per loop + agent task pass-rate + cost/task).
7. **Multi-machine identity & clock:** machine ids, clock-skew handling for valid-time across
   machines (logical vs wall clocks).
8. **Backfill:** how to bi-temporally backfill the existing corpus (sessions_v1 etc.) without
   fabricating valid-times we don't have.

## 7. Acceptance criteria for THIS requirements doc (definition of ready for design)

- [ ] Owner has reviewed and each R# is **accepted / amended / rejected**.
- [ ] The 8 open questions each have an owner steer (or are explicitly deferred to design).
- [ ] Priority/phasing agreed: which requirements are **wave 1** (likely: R17–R21 staging + R8–R11
  delta + R12–R16 execution tagging — the substrate) vs later (R22–R30 full loop automation).
- [ ] Confirm the "stage raw to the portable drive now" decision (R17) — proceed as a wave-1 quick win?

## 8. Suggested phasing (owner to confirm — not binding)

1. **Wave 1 — the substrate:** portable raw staging (R17–R21) + delta/watermark (R8–R11) +
   execution tagging (R12–R16). Makes multi-machine capture + reproducibility real. Low risk,
   high leverage; unblocks everything else.
2. **Wave 2 — bi-temporal + additive knowledge:** R1–R7 over the substrate; time-travel queries;
   privacy-honoring history.
3. **Wave 3 — the closed loop + agent loops:** R22–R30; the measured flywheel + the compound-value
   dashboard (R26).

---

*Ends. Design + task breakdown are deliberately excluded — hand this to the design session. The
existing skills (`longview-pipeline`, `house-trainer`, `delivery-board`, `phase-runner`) and this
session's EP-T artifacts are the substrate that session should build on.*

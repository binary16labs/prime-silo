# SPEC-run-events — the unified run-event stream (G0)

Status: implemented (G0). Source of truth for `runtime/benny/pypes/events.py`.

## Why

Before G0 there were three uncoordinated write paths for "what happened in a
run": pypes checkpoints/receipts, the OpenLineage `LineageEmitter`
(`runtime/benny/pypes/lineage.py`, HTTP to Marquez), and the governance audit
log. None gave a live consumer (a TUI, the Bridge) one place to tail for
progress + telemetry + lineage together, and the OpenLineage path could
block the hot path if Marquez was down (the RAG-ingest wedge lesson — see
`runtime/benny/governance/lineage.py` header comment). G0 makes the
run-event stream the *one* contract: exactly one producer (the pypes
orchestrator), append-only; every other consumer (lineage fold, OpenLineage
adapter, future TUI/Bridge) reads the stream instead of each other.

## Storage

```
PRIME_SILO_HOME/runs/<run_id>/events.jsonl
```

Root resolution: `PRIME_SILO_HOME` env, else `BENNY_HOME` env, else cwd —
matches the precedence already used elsewhere in the repo
(`server/api/home.js`). One append-only JSONL file per run, flushed after
every write.

## The DAG is frozen at `run_started`

The first line of every `events.jsonl` is a `run_started` header carrying
the full node list (the orchestrator's already-computed topological order)
and edge list. **No later event may reference a `node_id` not in that
header** — the schema-level guard against the 267 MB manifest-blowup lesson:
the DAG cannot silently grow mid-run. A writer that tries raises
`UnknownNodeError`; the orchestrator degrades (logs, does not raise) per the
non-blocking rule below.

## Event types

`run_started` (header, once) · `node_started` · `node_progress` ·
**`node_heartbeat`** (periodic while in flight: `phase`
`prefill|generating|assembling`, `tokens_so_far`, `compute_busy` — liveness
between state transitions, so a tracker can tell alive-but-silent from
stalled) · `node_finished` (+ `duration_ms`, `tokens_in/out`, `model`,
`endpoint`) · `node_failed` (+ `error`) · `node_retried` ·
`artifact_produced` (`artifact`, `uri`, `content_hash`) ·
`artifact_consumed` · `run_finished` · `run_failed`. Every event carries
`event`, `run_id`, `ts`; node-scoped events also carry `node_id`, `attempt`.
Extra fields are permitted; missing required fields are rejected.

## Lineage is a fold, not a system

`fold_lineage(events) -> {artifact_name: {produced_by, consumed_by}}` walks
`artifact_produced`/`artifact_consumed` events only — the *only* lineage
derivation for the G0 stream, no second write path.
`runtime/benny/governance/lineage.py` and `runtime/benny/pypes/lineage.py`
(OpenLineage/Marquez) remain **optional tail-adapters**: a separate consumer
can read `events.jsonl` and translate `artifact_*` events into OpenLineage
`RunEvent`s when `BENNY_LINEAGE_ENABLED=1`. That translation is out of scope
for G0 — this task only guarantees the stream carries what such an adapter
needs.

## Non-blocking write

Every `RunEventStream` emitter method never raises for I/O reasons. A write
failure is caught, logged once at `warning`, and the stream degrades to a
no-op for the rest of the run — the step's own success/failure is
unaffected. Same posture as `runtime/benny/pypes/lineage.py`'s "failures
here never propagate" rule.

## Compatibility

Existing local governance/AER events and the checkpoint/receipt-based Runs
readers are unchanged and keep working. This stream is additive; no legacy
reader is migrated or removed by this task (protocol rule 6 — parity first,
migration later, out of scope here).

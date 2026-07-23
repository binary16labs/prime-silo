# T2 — Dataset card (instruction + trajectory SFT set)

**Status:** 🟢 GATE GREEN — author-complete, **ready-for-verify** (author = claude on
the T480; verifier re-runs `node scripts/gates/t2.mjs`). Built: 2026-07-23.

Fine-tune quality is ~90% data. T2 turns the *already-structured* corpus into training
data — no LLM, no network, no fine-tune (that's T3). Data only.

---

## Streams

| Stream | Shape | Source | Rows (train + eval) |
|---|---|---|---|
| **A — method / voice** | `instruction → house-style response` | LONGVIEW cards + ADRs | **63** (56 + 7) |
| **B — agent tool-use** | `state + goal → next tool call` | memo-ray tool-call traces | **500** (424 + 76) |

**Total: 563 rows.** Held-out split: **15%** (`T2_EVAL_PCT`), assigned by a stable
FNV-1a hash of each row id — deterministic and **disjoint from train by construction**.

Row schemas (one authority: `scripts/train/lib/schema.mjs`):
- Stream A: `{stream:"A", id, instruction, response, source:{type:"card"|"adr", id, sid?}}`
- Stream B: `{stream:"B", id, state, goal, tool_call:{name, args}, source:{type:"trace", id, sid, agent}}`

## Source provenance

Built off the verified **T1 clone** (`D:\benny-home`):
- **61 LONGVIEW cards** (`benny/workspaces/longview/data_in/longview_card_*.md`) — both
  card templates handled (v1 `Intent/Applications/Decisions`, arc/v2
  `Overview/What happened/Threads and signals`). Responses are the cards' **real
  house-voiced text**, never fabricated.
- **2 ADRs** (`architecture/ADR-*.md`).
- **memo-ray traces** — `Tool Call` entities from `~/.mem0ray/data`, with state
  reconstructed by walking the conversation tree (`parent_id`). An entity's filename
  is its id, so ancestors resolve on-demand from disk: **498/500 Stream B rows carry
  real prior-step context**.

## Privacy / leak-gate summary

The operator does job-application / CV work in the same session estate — that context
must **never** enter training rows.
- Every candidate row passes a build-time detector (`scripts/train/lib/privacy.mjs`)
  using **generic** category markers (`scripts/train/dataset/personal_terms.json`:
  cv/resume/cover-letter/job-application/… — never the operator's real private data),
  augmentable by quarantined sids from `<home>/longview/quarantine.json`.
- **3 Stream B rows were excluded** as personal/job context in this build.
- The authoritative leak scan (`leak_gate.scanForLeaks`, the same gate the deliverable
  pipeline uses) over all emitted rows reports **0 hits**.
- **The generated rows are git-ignored — kept local by design** (they carry real
  internal session traces: local paths, usernames, session ids). The remote gets the
  pipeline + this card, not the corpus. Regenerate with `build_dataset.mjs`.

## Build / verify

```bash
node scripts/train/build_dataset.mjs   # emit dataset/*.jsonl + manifest.json (local)
node scripts/gates/t2.mjs              # validate (builds first if the set is absent)
node --test scripts/train/tests/build_dataset_test.mjs   # unit tests
```

The gate asserts: both streams present + schema-valid, held-out disjoint from train,
leak-gate 0 hits.

## Known limitations / refresh

- **Bounded trace slice** — Stream B iterates a deterministic slice of the memo-ray
  store (`T2_TRACE_MAX_ENTITIES`, default 6000) capped at `T2_TRACE_MAX_ROWS` (500).
  Scaling up is a config change + a longer build; the ~80k-entity store has much more
  Stream B to mine.
- **Gold audit** — the contract calls for a hand-audited ~200-row gold subset; the
  automated schema + leak gates are in place, the human spot-check is the open
  follow-up before T3 trains on this.
- **Refresh** — re-run `build_dataset.mjs` after a T1 clone refresh; the split is
  stable (hash-based) so held-out membership is reproducible across rebuilds.

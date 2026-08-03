# Review — is the delivery workflow actually wired to lineage and the dashboards?

**Asked:** confirm the workflow carries full regulator-grade lineage and reaches the observability
and telemetry dashboards. **Answer: it does not.** Four hops separate a board decision from the
lineage DAG, and three of them are open. Most parts exist — this is **wiring, not building** — but
today the claim would not survive an audit.

**Author:** claude-opus, 2026-08-03. **Verifier:** unassigned. **Status:** findings + proposed work.

---

## 1. What the chain should be, and where it breaks

```
delivery decision            B0 coordination ledger        execution register        lineage DAG
(claim/verify/done)   ──▶    tasks.jsonl, hash-chained ──▶ executions.jsonl    ──▶   lineage.html
       │                              │                            │                      │
   BOARD.md +                    ✗ HOP 1 OPEN              ✗ HOP 2 OPEN           ✗ HOP 3 OPEN
   LOG.md (markdown)          board never migrated       mapper never called    no coord source
```

### Hop 1 — the delivery board is markdown, not the ledger

Two disjoint stores exist. The board (`delivery/board/BOARD.md` + `LOG.md`) is markdown, in-repo,
versioned by git. The B0 coordination ledger (`$PRIME_SILO_HOME/coordination/tasks.jsonl`) is
hash-chained and tamper-evident, and lives **outside** the repo.

`SPEC-work-contracts.md` states the board is derived "from BOARD.md + LOG.md today and from the
B-ledger after B2", and **B2's own contract lists "delivery-board migration" under Out of scope** as
a post-B2 follow-up. So it was always deferred — but nothing downstream can see delivery until it
lands.

**Consequence:** every delivery decision in this session — promoting B2, claiming it, the w0
verification verdict, the merge — is recorded in markdown and git only. It is a real audit trail
(append-only by convention, immutable by git), but it is **not in the tamper-evident chain** and not
machine-queryable.

### Hop 2 — the coord→register mapper is dead code in production

`server/coordination/lib/exec_register.mjs` (L5) exports `fromCoordEvent(e)`, which maps a
coordination event into a register record tagged `source_log: "coordination"`. The mapper is correct
and tested.

Nothing calls it. Across the repo, `fromCoordEvent` / `buildRegister` / `projectRegister` appear in
exactly four files: the two `exec_register.mjs` libs themselves, `tests/authorship/`, and
`triad_dashboard.mjs`. **No server route, CLI verb, or scheduled job builds the register from
coordination events.**

### Hop 3 — the lineage DAG has no coordination source

`scratch/longview_run/dashboard/lineage.mjs` contains **zero** references to coord, `tasks.jsonl`, or
delivery. The OpenLineage DAG at `:8788/lineage.html` represents LONGVIEW pipeline runs. The delivery
workflow does not appear in it at all.

`triad_dashboard.mjs` (L14, `flywheel.html`) does consume the register — but read-only, via
`readRegister(registerPath)`. It is a consumer, not a producer, so with hop 2 open it has nothing
from coordination to show.

### Hop 4 (partial) — OpenLineage emission is opt-in and scoped elsewhere

`runtime/benny/governance/lineage.py` is a real OpenLineage client, but its own header records that
HTTP/Marquez emission is **opt-in** against an optional dev service, and it is Python-side, scoped to
Benny runs. It is not on the coordination path.

## 2. A fifth issue: the observability surface is unversioned

The dashboard lives under `scratch/longview_run/dashboard/`. `scratch/` is on the repo's
never-commit list. The telemetry surface the regulators would be shown is therefore a **local,
unversioned artifact** — it cannot be rebuilt from the repo, and no gate protects it from drift.

## 3. Regulator mapping (PRA SS1/23, against the estate's own control table)

| Control | Claimed | Actual, on this evidence |
|---|---|---|
| **P2** — governance & lifecycle accountability | MET | Holds for *mutating runs* (HMAC ledger, operator identity, device binding). Does **not** extend to delivery decisions, which are markdown + git. |
| **P3** — development, implementation and use; high-fidelity audit trail | MET | Overstated. Git history and `LOG.md` are a genuine and unusually honest trail, but they are prose, not machine-queryable lineage, and absent from the DAG. |
| **P4** — independent model validation | PARTIAL | Confirmed PARTIAL. Author≠verifier lives in `LOG.md` prose and is unenforced; W1 §6 proposes mechanizing it, and even then it enforces distinct identity strings, not independence. |
| **P1** — model identification and risk tiering | PARTIAL | Unchanged by this review. |

The estate's own standard, written into `REQUIREMENTS-trained-model-workflows.md` R9, is *"a
benchmark whose result is not in the ledger did not happen."* Applied consistently, the same sentence
convicts the delivery workflow.

## 4. Proposed work — wiring, in dependency order

None of this is new machinery; it connects parts that already exist and are already verified.

| id | What | Depends on | Note |
|---|---|---|---|
| `B4` | Delivery board → B0 ledger. Board transitions emit ledger events; BOARD.md becomes a *projection* of the ledger rather than the source. | B2 | B2's explicitly deferred follow-up. Closes hop 1. Everything else is blocked on it. |
| `B5` | Wire `fromCoordEvent` into a live register projection — on append via the B1 bus, plus a `benny coord register --rebuild` for backfill. | B4, L5 | Closes hop 2. The mapper exists; this is a caller and a write path. |
| `L15` | Emit OpenLineage RunEvents for the delivery lifecycle and add a coordination source to `lineage.mjs`, so claims/verifications/merges appear as a DAG. | B5 | Closes hop 3. |
| `L16` | Move the dashboard out of `scratch/` into a versioned path with a gate. | — | Independent; closes §2. Do first if the surface is to be shown to anyone. |

**Backfill matters for the regulator claim.** `fromCoordEvent` uses a deterministic `exec_id`
(`detId("coord:"+e.id)`), so a rebuild is idempotent and the historical board can be projected in
without inventing IDs — the same rebuildable-identity property L5's verifier mutation-tested. History
does not have to be lost to close these hops.

## 5. Why this is not being implemented right now

1. **`server/coordination/` is in W1's allowlist.** B5 and W1 would collide; ordering is required,
   not optional.
2. **B2 is mid-verification** by an independent verifier operating on these exact files.
3. **Scope enters through the plan.** `plan-deps.json` mirrors plan §12 and updates *only with a plan
   rev* (`SPEC-work-contracts.md`), so `PLAN-local-power-unified-ui.md` needs a revision adding B4/B5
   and L15/L16 before any of these contracts can pass `w0`.

## 6. What is true today, stated plainly

The delivery workflow **has an honest, complete, human-readable audit trail** — append-only `LOG.md`,
immutable git history, contract-per-task with gates, and independent verification recorded with its
caveats. That is better than most engineering organisations manage.

What it does **not** have is machine-verifiable lineage: the decisions are not in the hash-chained
ledger, not in the execution register, and not in the OpenLineage DAG. Anyone claiming the delivery
workflow is "wired to the observability and telemetry dashboards" today would be wrong, and the
distinction is exactly the one an SS1/23 reviewer would probe first.

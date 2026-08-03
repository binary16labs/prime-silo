# Plan revision proposal — lineage closure (workstream ML) + model plurality (workstream M)

**Status:** PROPOSAL for owner signature. **Nothing here is applied.** `plan-deps.json` mirrors plan
§12 and updates *only with a plan rev*, so this document is the rev — to be reviewed, signed, and
then applied **atomically** (see §5, which is the part most likely to break the board if ignored).

**Author:** claude-opus, 2026-08-03. **Blocks:** EP-M (M0–M5) and the lineage contracts, neither of
which can pass `w0` until the plan carries them.

---

## 1. The finding that changes the framing

The lineage work is **not new scope**. It is an existing, unmet key result:

> **KR2.2** — Every run is one event stream = progress + telemetry + lineage; TUI and Bridge render
> it identically (gates `g0`/`g1`/`g2`).

`REVIEW-delivery-lineage-2026-08-03.md` established that delivery decisions never reach the
execution register or the OpenLineage DAG. That is KR2.2 failing for the *delivery* stream
specifically. So B4/B5/L15/L16 need **no new KR** — they close one already on the board.

**KR2.4** — "100% of DONE tasks were verified by a non-author agent (audit of `board/LOG.md` /
ledger)" — is the second beneficiary. It says *audit of the ledger*, but delivery verification lives
in markdown prose today, so the audit it calls for cannot actually be run. W1's `task_verified`
(D3, in VERIFY now) makes the fact typed; B4 puts it in the ledger where KR2.4 expects it.

Model plurality is different: **KR1.5 is closed** and was specifically "a house-method QLoRA
measurably beats its base". Ranking *two* models on the agent loop is not that claim, so EP-M does
need a new KR.

## 2. Proposed OKR changes

| Change | Text | Rationale |
|---|---|---|
| **New KR1.6** under O1 | "Two or more candidate engines are ranked on the same instrument over the estate's own agent loop, with every metric either measured or explicitly `unmeasured`; the incumbent is displaced only on evidence." | KR1.5 is closed and does not cover comparison. Without this, EP-M has no chain and `w0` rejects it — `okr` must resolve to exactly one `TRACEABILITY.md` row. |
| **No change** to KR2.2 / KR2.4 | — | The lineage contracts close them as written. Adding a KR here would hide the fact that an existing one has been unmet. |

## 3. Proposed workstreams

### Workstream ML — lineage closure (KR2.2, KR2.4)

Wiring, not new machinery. Ordered by the hop they close.

| id | Epic | What | deps |
|---|---|---|---|
| `B4` | EP-B | Delivery board → B0 ledger. Board transitions emit ledger events; `BOARD.md` becomes a projection. B2's explicitly deferred follow-up. | `[B2, W1]` |
| `B5` | EP-B | Wire L5's `fromCoordEvent` into a live register projection (on-append via the B1 bus) plus `--rebuild` backfill. | `[B4]` |
| `L15` | EP-L | Emit OpenLineage RunEvents for the delivery lifecycle; add a coordination source to `dashboard/lineage.mjs`. | `[B5]` |
| `L16` | EP-L | Move the dashboard out of `scratch/` (never-commit) into a versioned path with a gate. | `[]` |

`L16` is independent and should go **first** if the surface is ever shown to anyone — today the
observability surface a regulator would be shown cannot be rebuilt from the repo.

`B4` depends on `W1` as well as `B2`: W1 introduces `task_verified`, and B4 should carry it into the
ledger in the same shape rather than being retrofitted afterwards.

### Workstream M — model plurality (new KR1.6)

`M0`–`M5` exactly as designed in `SOLUTION-model-plurality.md` §6. Unchanged, except that its
dependency is now explicit:

- `M0` deps `[W2]` — the owner's ordering decision of 2026-08-03 (W2 before EP-M).

## 4. Milestone

Both workstreams need a milestone, and `M1`–`M8` are all bound to shipped or in-flight scope.

**Proposed `M9-lineage-and-plurality`.** This carries a real cost worth stating: the milestone enum
in `server/coordination/work-schema/validate.mjs` is hard-coded `M1..M8`, so **`w0` will reject any
`M9` contract until that enum is bumped**. Precedent exists — the LOG records the enum being bumped
`M6→M7` when EP-N was authored. The bump must land in the same atomic change as everything else.

## 5. Atomicity — the part that breaks the board if ignored

`w0` enforces three couplings simultaneously:

- every `plan-deps.json` phase has a contract in `delivery/tasks/`;
- every contract is a plan phase (*"scope enters via plan revs"*);
- each contract's `deps` **equals** its `plan-deps.json` entry;

plus: every task id appears exactly once across board columns, and exactly once in
`TRACEABILITY.md`.

So this rev cannot be applied in pieces. **One commit** must carry: the plan §12 additions,
`plan-deps.json`, all ten contracts (`B4`, `B5`, `L15`, `L16`, `M0`–`M5`), the two new epic files or
edits, the `TRACEABILITY.md` rows, the `BOARD.md` AUTHORED entries, the `OKR.md` KR1.6 addition, and
the `validate.mjs` M9 enum bump. Anything less turns `w0` RED — the same gate that was RED for weeks
until today.

## 6. What the owner is signing

1. **KR1.6** as worded in §2 (or a rewording).
2. **`M9-lineage-and-plurality`** as the milestone, accepting the `validate.mjs` enum bump.
3. **The framing in §1** — that the lineage contracts close existing KR2.2/KR2.4 rather than
   introducing new scope. This is the load-bearing claim; if you disagree, the lineage work needs its
   own KR and the review's conclusion softens accordingly.
4. **Ordering:** `L16` first (independent), then `B4 → B5 → L15`; EP-M behind `W2`.

## 7. Not proposed here, deliberately

- **No GRPO contract.** Still blocked by R15 pending a pre-registered data-depth control arm.
- **No Gemma training contract beyond `M5` (E4B alone).** 12B stays deferred until E4B has a measured
  result on the M1–M4 instrument (R17.1).
- **No change to `w0` itself** beyond the enum bump. It was fixed today; leave it alone.

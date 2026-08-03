# Solution Design — W1: `work next`, the deterministic selector + delivery loop

**Contract:** `delivery/tasks/W1.md` · **Epic:** EP-W · **Status:** DRAFT, pre-claim.
**Author:** claude-opus, 2026-08-03. **Verifier:** unassigned.

> This document is written **before** W1 is claimed and is not W1 task payload — `architecture/` is
> not in W1's allowlist. If any of it should ship with the task, the contract needs an allowlist
> amendment (T4 precedent). W1 cannot be claimed until **B2 is verified DONE** (`deps: [W0, B2]`).

---

## 1. Why B2 is a real dependency, not bookkeeping

Scenario 2 ("concurrent pulls never collide") cannot be satisfied by selection alone. If `work next`
is a pure read, two agents calling it against identical state get the **same** item — that is what
determinism means. The only thing that can separate them is an atomic arbiter, and that is B0's wx
lease, reached through the B2 client. So W1's dependency on B2 is load-bearing.

## 2. The one design decision everything else follows from

**Split the selector from the loop.** Scenarios 1 and 2 pull in opposite directions: one demands the
same answer 100 times, the other demands a different answer each time. They are only reconcilable if
they are testing two different functions.

```
selectNext(contracts, state, { agent, now })  →  ordered candidate list      PURE. No I/O, no clock,
                                                                             no lease acquisition.
workNext(ctx, agent)                          →  the one item you now hold   Composes selectNext with
                                                                             claim-and-skip.
```

`workNext` walks `selectNext`'s ordered candidates and attempts a claim on each; `already-claimed`
means another agent won that item, so it moves to the next candidate. First successful lease wins and
returns. Nothing available → `null`.

- **Scenario 1** tests `selectNext` — pure, so 100 runs trivially agree, and the test is meaningful
  rather than a tautology about a cached value.
- **Scenario 2** tests `workNext` — the lease is the arbiter, so two agents cannot both hold one item.
- **Scenario 3** tests the loop's `done` transition, which is neither of the above.

Without this split, scenario 1's test would have to reset state between trials (testing the harness,
not the selector) and scenario 2 would be untestable.

## 3. The ready predicate

An item is ready when **all** hold:

| Condition | Source |
|---|---|
| every `deps` id is DONE | ledger fold (B0 `foldState`), not the board |
| no live lease | `<coordDir>/leases/<id>.json` absent or expired |
| authority satisfied | `agent-ok` → selectable; `human-signed` → requires a recorded owner signature |
| the contract itself validates | `server/coordination/work-schema/validate.mjs` |

**Governance risk to gate hard:** if `human-signed` is not enforced here, `work next` will hand agents
owner-gated work automatically. Every human-signed task on this board (L1, L3, L9–L13, N0, N3, N5, N7,
E0) was signed in chat. Until signatures are ledger events, `work next` must **refuse to auto-claim
`human-signed` items** and surface them as "awaiting signature" instead. That is the safe default; the
alternative silently converts a human gate into an agent action.

## 4. Ordering — a total order, or determinism is luck

Topological (dep order) → priority → lexicographic id. The third key exists to make the order
**total**: without it, two independent items at the same topological depth and priority tie, and the
tiebreak falls to Map/readdir iteration order, which is not a specification.

Determinism hazards, each of which has bitten this repo before:

- **Clock.** Lease expiry makes readiness time-dependent. `now` must be injected, never read inside
  the selector. (L4's delta engine and L8's bi-temporal projectors both take time as input.)
- **Randomness.** No ULIDs, no `Math.random` anywhere in selection. L5's verifier mutation-tested
  exactly this by salting `exec_id` with `Math.random` and watching rebuildable-identity go RED — W1's
  gate should carry the equivalent mutation.
- **Filesystem order.** Sort `readdir` output explicitly; never rely on it.

## 5. Board vs ledger — two sources of truth, one rule

`BOARD.md` is canonical today; the B-ledger becomes canonical after B2. During the overlap W1 reads
both, so it needs a stated rule rather than an accident:

- **State** (todo/claimed/verify/done/blocked) comes from the **ledger**.
- **Priority** (order within READY) comes from the **board**, because that ordering is human-edited
  and the ledger has no concept of it.
- **Disagreement is surfaced, never silently resolved.** If the board says DONE and the ledger does
  not, `work next` reports the conflict and refuses to select that item. Silently preferring one would
  reintroduce exactly the stale-column problem that left B2 sitting in AUTHORED for nine days with its
  dependency already satisfied — a staleness `w0` cannot see, because it checks that each id appears
  exactly once across columns, not that the column is the right one.

## 6. Scenario 3 — mechanizing author ≠ verifier

Today this is convention. Every DONE entry on the board carries a hand-written `verified-by`, and the
caveat "same harness/model family as author (not cross-harness)" recurs because nothing enforces it.

W1's `done` transition should reject a completion whose verifier identity equals the author identity,
where **author** = the agent on the task's `task_claimed` event and **verifier** = the agent on the
`verified-by` event, both read from the ledger.

**Reuse before building:** L6 shipped `server/coordination/lib/authorship.mjs`
(`validateAuthorship` / `requireAuthorship` / `recordServed`). Its concern is human/frontier/house
provenance tagging, which is adjacent but not the same as per-task author≠verifier. W1 should read it
first and extend it if it fits; a second authorship module would be the kind of parallel system B1's
verifier explicitly checked for and rejected.

Honest limit worth stating in the contract's handoff: this enforces *distinct identity strings*, not
genuine independence. An author who verifies under a second name passes. Mechanizing identity is worth
doing; claiming it guarantees independent verification would be overreach.

## 7. Surfaces

`benny work next|verify|done|blocked` (CLI) and the matching MCP tools, both thin clients of one
implementation — the same shape B2 established, and for the same reason: two surfaces that reimplement
a protocol drift. The selector itself belongs in `server/coordination/lib/` (in W1's allowlist)
alongside the other B/L libs, not inside either surface.

## 8. Scenario → test map

| Scenario | Test | Non-vacuity mutation |
|---|---|---|
| the selector is a function | `selectNext` over a fixed fixture, 100 trials, deep-equal | inject `Math.random` into the tiebreak → RED |
| concurrent pulls never collide | two `workNext` callers, 20 rounds, assert disjoint | make `workNext` skip the lease attempt → RED |
| author is never verifier | done event with verifier == author | remove the identity check → RED |

Plus, beyond the contract's three: a `human-signed` item is **not** auto-claimed (§3); completing an
item makes exactly its dependents ready and no others (the contract's TDD step 3); and a board/ledger
disagreement refuses rather than guesses (§5).

## 9. Settled before claiming (owner-directed, 2026-08-03)

### D1 — `work next` never auto-claims a `human-signed` item

The selector excludes `authority: human-signed` from the selectable set entirely and reports those
items separately as `awaiting-signature`.

*Rationale:* every human-signed task on this board (L1, L3, L9–L13, N0, N3, N5, N7, E0) was signed in
chat. There is no machine-readable signature today, so any rule that lets the loop take such an item
converts an owner gate into an agent action. Defining a signature format is deferred to its own
contract; until it exists, refusing is the only safe default.

*Consequence, stated so it is not later mistaken for a bug:* when only human-signed items remain,
`work next` returns nothing and says why. That is correct behaviour.

### D2 — board vs ledger precedence

**State** comes from the ledger. **Priority** comes from the board's READY order, which is the only
human-edited ordering and has no ledger equivalent. **Disagreement is surfaced and the item skipped**
— never silently resolved. The selector returns a `conflicts[]` alongside its choice.

*Rationale:* silently preferring one source reproduces the failure that left B2 in AUTHORED for nine
days with its dependency already satisfied — a staleness `w0` structurally cannot see, because it
checks that each id appears exactly once across columns, never that the column is the right one.

### D3 — verification becomes a first-class ledger event

Add **`task_verified`** to the B0 event enum (`server/coordination/schema/event.schema.json`) and
handle it in `foldState`. The addition is **additive**: every existing event still validates, and no
stored line changes meaning.

*Rejected alternative:* carry `verified_by` inside `task_done`'s payload. Cheaper — `payload` is an
unconstrained object, so it needs no schema change — but that makes author≠verifier an enforcement
against a **convention** rather than a validated field, and nothing would stop a `task_done` arriving
with no verifier at all. The lineage review of 2026-08-03 already found that delivery decisions are
not machine-queryable; recording verification as a typed, chained, validated event is the single
cheapest step toward SS1/23-P4, and it is what makes scenario 3 enforceable rather than advisory.

*Scope note for the verifier:* this modifies an artifact owned by **B0, which is DONE**.
`server/coordination/` is inside W1's allowlist so it is in scope, but the change must be additive
only and **B0's and B1's existing gates must still pass** — treat any regression there as a defect,
not an acceptable cost.

### D4 — WIP limit (carried over, now settled)

`work next` refuses an agent that already holds a live lease, returning `wip-limit` rather than a
second item. The README sets the limit at 1 per agent; without this the loop hands one agent five
tasks and the limit becomes decorative.

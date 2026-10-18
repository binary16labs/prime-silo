# PLAN — MVP recovery: make "done" measurable, then finish

**Status: DRAFT, UNSIGNED.** Scope enters through this plan, and this plan enters through the
owner's signature. M13 is signed and frozen; nothing below redefines a criterion except where it
asks, explicitly, for an amendment.

## The finding that forced this plan

M13 was signed on 2026-10-17 with five exit criteria, each supposedly naming its instrument. On
2026-10-18 I went to measure them and found that **three of the five cannot be measured at all**,
and a fourth can never pass. The rubric meant to cure vacuous gauges had four of them.

| Criterion | Its instrument                                                          | What the instrument actually does                                                                                                                                                                                                                                                                                                         |
| --------- | ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MVP-1     | "gate `q3` extended to the UI journey"                                  | **Nothing. It does not exist.** No gate covers first install.                                                                                                                                                                                                                                                                             |
| MVP-2     | `usecases_build.mjs` → `exercised == use_cases`                         | **Reads a hand-typed word.** `verified` is a string in `manual/usecases.json`; the build only checks it spells "exercised" or "declared". No test anywhere names a use case — grep for `UC-` under `tests/` returns nothing. So the "10 of 19 exercised" baseline is 10 claims, and the criterion is satisfiable by editing a JSON field. |
| MVP-3     | S21/S22 gates with the network off                                      | **Sound, but S22 does not exist yet** — it is AUTHORED, waiting on S21.                                                                                                                                                                                                                                                                   |
| MVP-4     | `evidence_pack.mjs` → verdict clean                                     | **Sound and honest** — but unachievable. Both unauthorised runs carry `proposal_id: null`. An orphan has no proposal to sign and the ledger is append-only, so the count can never reach 0.                                                                                                                                               |
| MVP-5     | "the Release arc performs raise → sign → publish → install with no CLI" | **Prose, not a command.** Nothing exits 0 or 1 on it.                                                                                                                                                                                                                                                                                     |

This is the same disease as the OKRs M13 was written to cure: 18 KRs, 2 scores in 490 log lines.
Writing criteria does not create measurement. **So the first work is not product work — it is
building the ruler.** Until then "all five green" is a sentence anyone can make true by typing.

I drafted those criteria. The defect is mine, not the signature's.

## The second finding: why 54 contracts sit AUTHORED

On 2026-10-03 the owner stopped the board: _"we have overcomplicated what we set out to do"_ —
weeks of gating a read-only map adversarially while they still could not see their estate. The
decision was: **read-only work gets one gate run and one independent check; the adversarial bar is
for code that moves or deletes data, or sends file details between machines.**

That decision was never applied. S21 — a read-only catalogue — then took three full adversarial
verification rounds (37 to 68 mutations each, an 8-hour real-F: pass, three FAILs) and is still
unverified at round 4. S1 took five. Each round found real defects, so the rounds were not waste;
the mis-sized _scope_ is the waste, and it is why the queue is 54 deep and nothing ships.

A plan that does not fix throughput cannot be executed, so the throughput rule is phase 0 work.

## Phase 0 — build the ruler (no product change)

- **R1 · `exercised` must be earned.** Each use case gains `exercised_by: [<test id>]`.
  `usecases_build.mjs` refuses the word "exercised" unless every named test exists **and ran green
  in this invocation**, and reports `unproven` otherwise. This re-measures the 10 existing claims
  as well as the 9 gaps, so the MVP-2 baseline becomes a measurement instead of an assertion.
  _Instrument for MVP-2. Highest leverage job on this plan._
- **R2 · one scorecard, one exit code.** `scripts/mvp_scorecard.mjs` runs all five instruments,
  prints a criterion-by-criterion table with measured values, writes `okr-score` lines to
  `board/LOG.md`, and exits non-zero while any criterion is red or unmeasurable. "Is it finished?"
  becomes a command.
- **R3 · the throughput rule, written down.** `delivery/README.md` gains the 10-03 decision as a
  binding rule: verification scope is set by what the code _does_. Read-only: one gate run, one
  independent check. Writes, moves, deletes, or crosses a machine boundary: the adversarial bar,
  unchanged.
- **R4 · MVP-4 amendment (owner's signature required).** Recommended wording: _no unauthorised run
  beyond the two named orphans `01M1XP3VBYXHAY3WNZKC0XZ7E6` and `01M1XP4CASMHGDBXJ9XD02BMS0`,
  frozen at two._ A third orphan fails the gate; the two stay named in the pack, excluded but
  visible. Same idiom as the pack's 20 pre-control runs and the validator's `OVERSIZE_GRANTED`
  pin. The alternative — leaving MVP-4 as written — blocks publishing permanently, so a decision
  is needed either way.

## Phase 1 — unblock, in this order

- **S21 round 4, scoped by R3.** Its read path is unchanged since round 2 and verifier-3 confirmed
  that, and rounds 2 and 3 already measured the real-F: criteria. Round 4 therefore needs the D7
  crash attack reproduced (two hubs, one store, 5 ms polling, four downloaders), the s21 gate, and
  the budget re-derived — not a fourth adversarial sweep. Hours, by a fresh-context verifier.
- **Push.** 208 commits are unpushed against an `origin/main` ref last fetched 2026-09-27. Nothing
  installable can be built from an unpushed tree, so MVP-1 and MVP-5 both sit behind this.

## Phase 2 — make the criteria go green

Ordered by cost, not by criterion number. MVP-2 first because it needs no new features.

- **MVP-2** — write the 9 missing journey tests, and prove or demote the 10 existing claims under
  R1. UC-19 (publish a release the estate can account for) is the one already walked by hand, so
  it converts cheaply. UC-02 keeps its honest gap: raising is CLI-only, so either a screen is
  authored or the criterion records that the front door to governance has none.
- **MVP-1** — author the contract, then build the journey gate. Headless Electron already runs
  here (proven incidentally during S21), but driving a UI journey headlessly is unproven; if it
  cannot be driven, the honest instrument is gate `q3`'s existing shape — a fresh agent walking
  the installer from the doc alone — with **the number of shell commands required** as the
  measured value. Zero is the target; whatever it is today is the baseline.
- **MVP-3** — S22 built and verified (adversarial bar: it answers from the catalogue, so it reads
  owner data), then the gate re-run with the adapter disabled.
- **MVP-5** — the in-app path driven end to end, plus one recorded install on a second machine.
  The install half is measured by hand and must be labelled so, not quietly folded into a green.

## Phase 3 — score, then publish

Run R2's scorecard. Every criterion green, each with its measured value in `board/LOG.md`, a
non-author verifier confirming the run, then the MVP tag — the first tag M13 permits.

## What this plan does NOT do

It authors no new epic, and it does not touch the M13 out-list. EP-T, EP-M, EP-D, EP-R, the book
pipeline, ASUS burst and EP-U U5–U10 stay deferred. The 54 AUTHORED contracts stay authored.

## Exit

`scripts/mvp_scorecard.mjs` exits 0 with five measured criteria, and the number it reports for
each one was produced by a command rather than written by hand.

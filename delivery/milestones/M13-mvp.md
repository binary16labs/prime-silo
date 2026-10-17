# M13 — MVP: the product is finished → **tag unset**

**Scope (signed by the owner 2026-10-17, as written):** the five exit criteria below, the explicit
out-list, and the three rules that make it a cut. The rubric is **frozen at this signature** and the
readings in the table are the **pre-registered baseline** — a criterion may be failed, never
redefined. The target tag is deliberately unset: M11 holds v1.26.0 and M12 is unwritten, so the MVP
number is assigned when the first criterion goes green.

## Why this milestone exists

The board has 64 tasks DONE and `board/LOG.md` carries **2** `okr-score` events in 490 lines. The
delivery system measures outputs faithfully and has almost never measured an outcome. OKR.md already
holds 18 KRs across four objectives — the outcome layer is authored, not read. Meanwhile 131 task
contracts exist, 56 of them AUTHORED and waiting on dependencies, which is enough work to keep
shipping for months without ever answering "is it finished?".

So this milestone adds no new capability. It is a **cut**: the smallest set of outcomes that makes
Prime-Silo a product someone can be handed, with everything else named as deferred rather than
quietly in flight.

## The outcome

> A person installs Prime-Silo on one machine and, **without ever opening a terminal**, can see what
> their estate holds, ask it a question and get a grounded answer, approve or refuse work, and
> afterwards prove what happened and who authorised it — with the machine offline.

That sentence is the product. Every exit criterion below is a clause of it, and anything that is not
a clause of it is out.

## Exit criteria (the definition of done)

Each names its instrument. A criterion with no instrument scores 0 — it does not score "probably".
Readings below are from 2026-10-17 and are the pre-registered baseline.

| #     | Outcome                                                                           | Instrument                                                                                        | Reading today                                                                       |
| ----- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| MVP-1 | A fresh install reaches first useful result with **zero shell commands**          | gate `q3` runbook, executed by a fresh agent from the installer alone, extended to the UI journey | **unmeasured** — no gate covers the UI journey                                      |
| MVP-2 | Every surface a user is told about is **exercised**, not declared                 | `scripts/usecases_build.mjs` → `exercised == use_cases`                                           | **10 of 19** exercised, 9 declared; UC-02 has no screen at all                      |
| MVP-3 | A question about the estate gets a **grounded answer with the network off**       | EP-S S21/S22 gates, re-run with the adapter disabled                                              | **unmeasured** — S21 in VERIFY round 4                                              |
| MVP-4 | Authorisation is **complete and provable**: no unauthorised run, no vacuous gauge | `scripts/evidence_pack.mjs` → verdict clean                                                       | **defects found** — 2 unauthorised runs of 1743 in scope                            |
| MVP-5 | The app **updates itself**, in-app and governed — no human running scripts        | the Release arc performs raise → sign → publish → install with no CLI                             | **partial** — path exists, publishing still driven from `scripts/release_raise.mjs` |

**Done = all five green, each by its own instrument, scored into `board/LOG.md` as `okr-score`
events, with a non-author verifier confirming the run.** Four of the five are red or unmeasured
today, and that is the honest starting line.

## Explicitly OUT of the MVP

Deferred by this cut, with no loss of the work already done. None of these is cancelled; none of
these may block the MVP tag.

- **KR1.5 / EP-T** — the house QLoRA model driving the offload path.
- **KR1.6 / EP-M** — ranking two or more engines on one instrument.
- **KR3.4 / EP-D** — Studio's fourth output type (Audio Overview).
- **EP-R** — reverse-engineering: fixture SAD, interface catalogue.
- **EP-L book pipeline** — _The AI Vampire_, the audiobook, the arc-driven opus phases.
- **Multi-node burst** — ASUS fan-out beyond the Pi 5 anchor; the GC dashboard.
- **EP-U U5–U10** — moving and retiring data. The MVP catalogues; it does not consolidate.

**Open conflict, for the owner to resolve:** M11 (signed 2026-10-11, v1.26.0) scopes U0–U9, and this
cut defers U5–U10. Two signed scopes therefore disagree about the later consolidation phases. Either
M13 re-sequences M11 so v1.26.0 ships U0–U4, or the MVP admits the copy-and-verify phases. Nothing
in M11 is unsigned by this file; the question is only which milestone carries U5–U10.

## The rule that makes it a cut

1. The rubric above is **frozen at signature**. A criterion may be failed, never redefined — a moved
   goalpost is the one failure mode this milestone exists to prevent.
2. While M13 is open, **only work tracing to MVP-1..5 is claimable.** New epics are authored, not
   started.
3. **No publish until all five are green.** The owner asked for the product to be finished before
   publishing, so the release gate becomes the MVP gate: the next tag is the one this
   milestone permits. M12 belongs to EP-K (task K0); the MVP number is the owner's to set.

## Human-signed stops

This file (scope), and the MVP-1 runbook if it touches a machine's installed state.

**Exit:** the five instruments above, each reported with its measured value, plus non-author
verification. VISION-CHECK against the outcome sentence, not against the task list.

# The AI Vampire — V2 plan

**Status:** design, not yet built. Written 2026-08-01 while the LONGVIEW session debt clears.

## Why V2

V1 is 60,149 words / ~171 pages across 4 parts and 86 sections, and it reads well. Its
deterministic coverage report states the problem plainly:

```
distinct sessions cited : 59 of 261 cards (22.6%)
dossiers referenced     : 11 of 40
citation-coverage       : 0.35 threshold -> BELOW
```

The book is written against **less than a quarter of the corpus**. This is the *same
structural defect* found and fixed in the SAD: narrative generated against a small shared
evidence pool, so sections paraphrase one another and the estate's actual history stays
unused. V1's chapters were planned thematically and then written; the corpus was consulted,
not walked.

**V2 applies the spine learnings.** Every fix below already exists as proven machinery in
`togaf_epic_v5/v6.py` and `scripts/longview/lib/exec_register.mjs` — V2 is porting a working
architecture to the book, not inventing one.

## The six learnings, applied

### 1. Per-section retrieval (SAD v5, the single biggest lever)
V1 gave a chapter's sections a shared evidence pool. V2 gives **each section its own
retrieval** over cards, dossiers and the knowledge graph — a section-specific query, executed,
and the returned slice is what the section is written against.

*Expected effect:* coverage moves from 22.6% toward the 80%+ band, because sections stop
competing for the same 59 cards. This mirrors the SAD going from 0 to 50 sections with their
own evidence.

### 2. An inventoried spine, not only a planned one (SAD v6)
Keep the four-part narrative arc — it is good and it earns the title. But add chapters whose
**index is derived from the corpus**, so the book cannot silently drift from what happened:

| Chapter group | Index derived from |
|---|---|
| Part 1-4 (narrative) | arcs (`lib/arcs.mjs`) — unchanged, this is the story |
| **The Record** (new) | one section per major project/arc, from card counts |
| **The Reckoning** (new) | the failure taxonomy — 354 captured failures, by class |
| **The Ledger** (new) | the Execution Contract Register: real runs, contracts, outcomes |

### 3. Cite the register, not generalities (v7 spine)
V1 argues about governing multi-agent systems in the abstract. V2 can cite **measured fact**
from `execution_register.json`: 191 executions across 8 typed classes, 311 processes with 16
failures, 24 contracts, 2,387 hash-chained events — and the finding that **147 of 191
executions (77%) ran with no governing contract**. A book about taming autonomy should show
its own estate's autonomy being untamed, then tamed.

Likewise the flywheel: 23-27 sessions of debt, oldest 68.8 days, 22 of them stranded behind an
offline satellite. That is a *literal* story about memory decay, not a metaphor.

### 4. Citation validity gate (the v5 bug that cost ~4h)
V1 counts citations. V2 must also **validate** them: every cited session id must exist in the
card corpus, and invalid citations fail the section gate. In the SAD this bug scored every
valid citation as invalid and doubled runtime; here the inverse risk applies — uncheck
citations and the book can cite sessions that do not exist.

### 5. Figures as an obligation, rendered in code (SAD v6)
V1 has no figures. V2 reuses the **v6 diagram engine** (`render_graph`, budgeted, sharded,
sanitised) for a small set of real figures: the flywheel and its debt, the lineage job/dataset
graph, the failure taxonomy, the arc timeline. The model never authors diagram source — the
PDF gate (`svg_rendered >= mermaid_blocks AND svg_over_tall == 0`) is inherited, including the
fit pass that fixed diagram/text overlap.

### 6. Declare gaps inline, never imply green
The coverage report exists but sits beside the book. V2 puts **per-chapter coverage** in the
book itself: cards cited, dossiers used, evidence gaps named. A chapter that could not find
evidence says so.

## Proposed structure

```
Front       Contents · How this book was made (method, corpus, gates)
Part 1-4    The existing narrative arc (Hunger / Blood / Taming / Sovereign)
            - each section now retrieval-bound, with per-section coverage
Part 5      THE RECORD      — inventoried: one section per project/arc
Part 6      THE RECKONING   — the failure taxonomy, walked
Part 7      THE LEDGER      — the register: contracts, executions, governance debt
Part 8      TRANSFER        — the method without the estate (technical voice)
Appendix    Coverage report · citation index · evidence bibliography · reproducibility
```

Parts 1-4 stay the argument. Parts 5-7 are the evidence the argument stands on — and they are
inventoried, so they grow with the estate rather than being rewritten. Part 8 lifts the method
off the estate entirely, so the book is portable rather than self-referential.

## Build plan

1. `scripts/longview/opus_v2.mjs` standing on the existing opus/arcs machinery (do not fork
   the book pipeline; extend it, as v5 extended v3).
2. Section planner emits `{title, goal, query, figure}` per section — the v5 pattern.
3. Retrieval over cards + dossiers + graph; card ids carried as citations.
4. Gates: word floor, >=1 **valid** citation, references block, per-chapter coverage.
5. Figure rendering via the v6 engine; PDF via `togaf_epic_pdf.mjs` (fit pass inherited).
6. Coverage target: **>=70% of cards cited at least once**, reported and enforced.

## Preconditions

- **Clear the session debt first.** Building V2 against a corpus 27 sessions behind would bake
  the gap into the book. The map run is in flight now.
- Satellite sessions newer than 2026-07-27 remain unreachable while the ASUS is offline; V2
  should state that boundary rather than pretend completeness.
- Runtime: expect a long generation pass on gemma (V1's scale plus higher coverage). Same
  resume-on-wedge runner discipline as the SAD builds.

## Voice — decided

**Parts 5-7 are written in a technical voice.** Decided by the owner 2026-08-01, and the
reasoning changes the book's purpose rather than just its register:

> a technical voice is expected given the nature — it proves that given the domain, this
> framework could be transferable

That reframes the back half. Parts 5-7 are not an appendix of evidence for Parts 1-4; they are
a **reference implementation of a transferable method**. The literary front half argues *why*
multi-agent systems decay without governance; the technical back half demonstrates *how* it was
governed, in enough operational detail that a reader in another domain can port it.

### What this adds to the structure

Each of Parts 5-7 gains an explicit **transfer** closing: what is estate-specific, what is
domain-independent, and what a reader would substitute.

| Mechanism (domain-independent) | This estate's instance | What another domain substitutes |
|---|---|---|
| Contract register binding execution to a governing template | `execution_register.json`, 24 contracts | any job/pipeline catalogue |
| Evidence-derived gates, re-checked at decision time | launch gate, PDF SVG gate, section gates | any release/approval control |
| Debt as the brake on a compounding loop | LONGVIEW unmapped sessions | any backlog that starves a model |
| Tamper-evident, hash-chained authorisation | HMAC launch ledger + device id | any signed audit trail |
| Coverage declared, gaps named, never implied green | per-section coverage + gate tables | any assurance report |
| Framework mapping as a first-class artifact | TOGAF ADM / BCBS 239 / SS1/23 tags | the reader's own regime |

A new closing part carries this explicitly:

```
Part 8   TRANSFER — the method without the estate
         what generalises, what does not, and the honest limits
```

This is also the strongest answer to the regulator's original complaint. A framework that can
only describe the system that produced it is a report; one that can be lifted into another
domain is a method. The technical voice is what makes that claim checkable.

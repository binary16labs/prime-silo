# Data plan v3 — growing the house-method dataset (post-T3)

**Why:** the T3 v2 result is lopsided. Stream B (tool trajectories, 2,098 rows) improved
−64.6% NLL; Stream A (method/voice, **56 rows**) improved only −9.2%. The model is learning
*how we drive tools* but barely touching *how we reason and write*. Every lever below is
ranked by expected impact on that gap. Rubric stays frozen (`scripts/train/eval/rubric.md`);
every new source goes through the leak gate; **no CV/job-application content, ever**.

Principle carried from Workstream T: **method in weights, facts in RAG.** We add rows that
demonstrate reasoning, judgment, and voice — never rows that quiz the model on facts the
RAG stores already hold. And **house voice comes only from real house text** — no synthetic
LLM paraphrases (voice contamination); template variety yes, generated content no.

---

## Lever 1 — Grow Stream A from method-dense sources we already have (highest impact)

Current A = 61 LONGVIEW cards + 2 ADRs. Untapped, all already written in house voice
(corpus surveyed 2026-07-24 — `sessions_v1` is the motherlode T2 never read):

| source | est. pairs | shape |
|---|---|---|
| **`D:\...\workspaces\sessions_v1\longview\cards` — 376 JSON cards** (intent/applications/capabilities/decisions; T2 only read the 61 markdown cards in the live home) | ~330 after quarantine filter | new `readJsonCards` → same pair shape as `cardToPairs` |
| `sessions_v1\data_out` curated prose: **34 dossiers** (What-it-is/Trajectory sections) + **7 book chapters** + discovery loops + reviews | ~120–180 | sectioned md → (topic prompt → house prose), chunked ≤1600 chars |
| `delivery/board/LOG.md` (103 entries, the densest method text in the estate: root-cause notes, honest deviations, verify-before-merge discipline) | ~80 | "How did we handle X / what did we log and why" → the entry's own narrative |
| `delivery/tasks/*.md` (66 contracts: Goal + TDD plan + BDD scenarios) | ~120 | "How do we structure/gate a piece of work like X" → Goal+TDD sections; "Write the acceptance scenario for X" → gherkin |
| `architecture/*.md` (16 docs: ADR-001..004, OPERATING_MANUAL, SPEC-work-contracts, SPEC-run-events, TECH_DEBT, REVIEW-*) | ~60 | extend `adrToPairs` to all sectioned method docs |
| memo-ray **Thought** entities (~18,000 est.; the literal in-flight reasoning voice) | ~300–500 after filters | (preceding state → next thought) pairs; filter: ≥120 chars, has a decision verb, dedupe near-identical |

**Rollups verdict** (`sessions_v1\longview\rollups`: capabilities/projects/operator/sids
JSON maps): inventory-shaped **facts** → excluded from training by the method-vs-facts
design split. Used instead to (a) stratify the gold-audit sample and (b) report per-project
balance in the builder stats. `windows/` (4,273) are intermediates the cards already
distill — skipped as redundant/noisier.

**Privacy hardening that this source demands:** `sessions_v1\longview\quarantine.json`
lists the teleported (privacy-quarantined) sids. The new readers must (a) drop any
card/window whose sid is quarantined and (b) **feed those sids into the leak-gate sid
list** — today the gate runs term-matching only (`sids: 0`); this makes quarantine
exclusion structural, not lexical.

**Target: A train 56 → 700–1000 rows; A eval 7 → 100–150** (the 7-row eval is statistically
noisy — this fixes the instrument too). Instruction phrasing: extend the deterministic
FNV-1a template picker; per-source template families.

## Lever 2 — Deepen Stream B (moderate impact, cheap)

1. **Full-corpus sweep:** caps 40k→80,555 entities / 2,500→uncapped-with-quality-caps.
   Tool Calls are ~10% of entities → ~8k candidate rows before filters.
2. **Per-tool cap** at ~20% of the stream (Bash is 30% today) so mid-tail tools
   (task tools, MCP browser/preview tools, PowerShell) get real representation — T4's
   router cares about exactly these.
3. **Goal-residual fix:** 27% of goals are the `invoke X` fallback. Widen the ancestor
   walk `maxAncestors` 4→8 and also accept the nearest ancestor *Thought* first line as
   goal (it usually states intent). Expect residual <10%; rows still degenerate after
   that stay excluded rather than kept.
4. **Near-dup collapse:** same tool + normalized args (paths/hashes stripped) → keep first
   per session. Exact-dup rate is already 2.7%; this targets the near-dup band.

**Target: B train 2,098 → ~4,000–5,000 higher-diversity rows.**

## Lever 3 — Trajectory depth (new capability, medium effort)

Current B rows predict one next call from 4 ancestors. Add a **continuation variant**:
state includes the prior Tool Call *and its Tool Result summary* → predict the following
call. This teaches result-conditioned tool chaining (retry-on-error, read-then-edit,
test-then-commit), which is the agent behaviour T4 actually serves. Emit as `stream: "B"`
with `source.variant: "chain"`; cap at ~25% of B so single-step remains dominant.

## Lever 4 — Quality gates before any retrain (discipline, not optional)

1. **The open T2 residual: hand-audited gold subset.** Script emits a stratified 200-row
   sample (`scripts/train/audit_sample.mjs`) → owner reviews → corrections become
   exclusion rules in the builder. This is a human-signed step.
2. Truncation audit: report rows whose encoded length > max_seq (2048) — decide
   keep-clipped vs exclude per class instead of silently clipping.
3. Leak gate over every new source file class (LOG, contracts, book prose, Thoughts)
   **before** rows enter the builder; extend `personal_terms.json` if the Thought sweep
   surfaces new personal-context markers.

## Lever 5 — Retrain v3 + honest measure (same instrument)

- Rebuild → t2 gate GREEN → **re-run base eval on the new split** (same reason as v2:
  same instrument on both sides) → train (A oversample drops 4→2 once A is ~700;
  2 epochs; hparams otherwise frozen) → tuned eval → t3 gate → report addendum.
- Success criteria for v3 vs v2 (recorded now, before the run): **A_nll delta moves from
  −9.2% to ≤ −25%** while B_nll delta stays ≤ −50% and tool-name match does not regress.
  If A doesn't move, the honest conclusion is that voice needs a bigger base or DPO (T5),
  not more of the same data.

## Sequencing & cost

| step | wall time | blocking |
|---|---|---|
| L1+L2+L3 builder extensions + tests | agent work, ~1 session | — |
| Rebuild + audits + leak gate | ~15 min | — |
| L4 gold-subset hand-audit | owner, ~1h | human-signed |
| Base re-eval → train v3 → tuned eval | ~0.5h + ~2.5h + ~1h GPU | GPU single-file |
| Merge GGUF v3 (staged on D:) + gate | ~1h | after evals |

**Not doing (and why):** KG fact-recall rows (facts live in RAG by design); synthetic
paraphrase augmentation (voice contamination); scraping anything outside the estate
(privacy surface). Board-wise this lands as a T2-continuation data refresh + T3 report
addendum (same pattern as the v2 refresh), unless the owner prefers a fresh task id.

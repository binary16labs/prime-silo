# EP-A — Local model power

**Objective:** O1 · **Goals:** P1,P9 · **Milestone:** M1
**Plan source:** `../../architecture/PLAN-local-power-unified-ui.md` (workstream A)

Local qwen3.5-9B-FLM does real execution work: verified path, windowed generation respecting prefill economics, dev/knowledge/agent-support manifest packs, offline assurance, sovereignty gradient for weak hardware.

## Phases → task contracts
- [ ] `A0` — verify real offload path (FIRST after Q0)
- [ ] `A1` — windowing/assembly helper (≤~400-tok outputs, few full windows)
- [ ] `A2` — dev-task pack (commit_summary, docstring_gen, unit_test_gen, log_triage, code_review_notes)
- [ ] `A3` — knowledge-task pack (summarize_doc, card_gen, graph_enrich_batch, report_section)
- [ ] `A4` — agent-support offload_exec front door
- [ ] `A5` — offline assurance (localhost-only network audit)
- [ ] `A6` — sovereignty gradient (full local / LAN / frontier-assisted)
- [ ] `A7` — LONGVIEW card schema v2 (ONLY after current v2 run completes)

## Exit
All phase gates green, verified by non-author agent; close with a VISION-CHECK note (plan §0.5):
which KRs moved, measured evidence, one honest sentence on drift.

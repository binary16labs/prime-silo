# Kanban board (canonical until Bridge B3 renders the ledger)

> Rules: agents take the TOPMOST item in READY. WIP limit: 1 per agent. Moves are commits.
> Only the non-author verifier moves VERIFY → DONE. Order in READY = priority (human-edited only).

## READY  (take from the top)
- G0 — unified run-event stream spec  *(authored, tasks/G0.md)*
- C0 — design system contract  *(authored, tasks/C0.md)*
- A0 — verify real offload path  *(authored, tasks/A0.md — needs lemonade up; blocked-by-service is honest)*
- W0 — work-contract format + full backlog conversion  *(authored, tasks/W0.md — converts remaining plan phases into tasks/)*

## CLAIMED (agent · date)
*(empty)*

## VERIFY (awaiting non-author verification)
- B0 — coordination ledger spec + validator · author claude · 2026-07-07 · gate b0.mjs GREEN (6/6 scenarios incl. 20/20 wx race) on branch feat/B0 (.worktrees/B0) — verifier: re-run `node scripts/gates/b0.mjs` from clean checkout of feat/B0 (zero dependencies, no npm ci needed)
- Q0 — security remediation · author claude · 2026-07-06 · gate q0.mjs GREEN (8/8) on branch feat/Q0 (.worktrees/Q0) — verifier: re-run `node scripts/gates/q0.mjs` from clean checkout of feat/Q0 (needs `npm ci` first). MERGE DEFERRED until the live LONGVIEW run completes (see LOG)
- A9 — server-side call deadlines · author claude · 2026-07-06 · gate a9.py GREEN — verifier: re-run `python scripts/gates/a9.py` from clean checkout
- A8 — model-routing hygiene + ingest resilience · author claude · 2026-07-06 · gate a8.py GREEN — verifier: Antigravity re-run `python scripts/gates/a8.py` from clean checkout

## DONE (id · verified-by · date)
*(empty)*

## BLOCKED (id · reason · date)
*(empty)*

## BACKLOG (not yet authored as contracts — W0 authors these from the plan)
A1 A2 A3 A4 A5 A6 A7 · B1 B2 B3 · W1 W2 W3 · G1 G2 G3 · C1 C2 C3 C4 C5 C6 · D1 D2 D3 · E0 E1 E2 ·
F1 F2 F3 F4 F5 F6 F7 F8 · C7 · Q1 Q2 Q3 · R0 R1 R2 R3 (M2) · M2-1..M2-7 (after C6)

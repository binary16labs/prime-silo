# Kanban board (canonical until Bridge B3 renders the ledger)

> Rules: agents take the TOPMOST item in READY. WIP limit: 1 per agent. Moves are commits.
> Only the non-author verifier moves VERIFY → DONE. Order in READY = priority (human-edited only).

## READY  (take from the top)
*(empty — next entries arrive when feat/W0 merges: B1, Q1, E0)*

## CLAIMED (agent · date)
- G0 — unified run-event stream spec · claude-g0 · 2026-07-07
- C0 — design system contract · claude-c0 · 2026-07-07
- A0 — verify real offload path · claude-a0 · 2026-07-07 (lemonade confirmed up by owner)

## VERIFY (awaiting non-author verification)
*(empty)*

## DONE (id · verified-by · date)
- W0 — work-contract format + full backlog conversion · verified-by claude-verifier · 2026-07-07 *(on feat/W0, merge pending)*
- B0 — coordination ledger spec + validator · verified-by claude-verifier · 2026-07-07 *(merged to main 2026-07-07)*
- Q0 — security remediation · verified-by claude-verifier · 2026-07-07 *(merged to main 2026-07-07 — LONGVIEW run stopped by owner; NOTE: resuming LONGVIEW now requires BENNY_API_KEY in env or state/hmac-key keystore, fail-fast by design)*
- A9 — server-side call deadlines · verified-by claude-verifier · 2026-07-07 *(on main, released v1.12.6)*
- A8 — model-routing hygiene + ingest resilience · verified-by claude-verifier · 2026-07-07 *(on main, v1.12.3-5; known residual: lemonade health-probe shape, see LOG 2026-07-06T15:20)*

## BLOCKED (id · reason · date)
*(empty)*

## BACKLOG (not yet authored as contracts — W0 authors these from the plan)
A1 A2 A3 A4 A5 A6 A7 · B1 B2 B3 · W1 W2 W3 · G1 G2 G3 · C1 C2 C3 C4 C5 C6 · D1 D2 D3 · E0 E1 E2 ·
F1 F2 F3 F4 F5 F6 F7 F8 · C7 · Q1 Q2 Q3 · R0 R1 R2 R3 (M2) · M2-1..M2-7 (after C6)

# Kanban board (canonical until Bridge B3 renders the ledger)

> Rules: agents take the TOPMOST item in READY. WIP limit: 1 per agent. Moves are commits.
> Only the non-author verifier moves VERIFY → DONE. Order in READY = priority (human-edited only).
> AUTHORED = contract exists in tasks/ but dependencies are not DONE yet; items move to READY
> (bottom, owner may reorder) when their last dep is verified DONE. Gate: scripts/gates/w0.mjs.

## READY  (take from the top)
- B1 — coordination server API + SSE  *(dep B0 DONE — entered READY 2026-07-07)*
- Q1 — reproducible supply chain  *(dep Q0 DONE — entered READY 2026-07-07)*
- E0 — website design brief + claims registry  *(zero-dep — entered READY 2026-07-07; human-signed)*

## CLAIMED (agent · date)
- G0 — unified run-event stream spec · claude-g0 · 2026-07-07
- C0 — design system contract · claude-c0 · 2026-07-07
- A0 — verify real offload path · claude-a0 · 2026-07-07 (lemonade confirmed up by owner)

## VERIFY (awaiting non-author verification)
*(empty)*

## DONE (id · verified-by · date)
- W0 — work-contract format + full backlog conversion · verified-by claude-verifier · 2026-07-07 *(merged to main 2026-07-07)*
- B0 — coordination ledger spec + validator · verified-by claude-verifier · 2026-07-07 *(merged to main 2026-07-07)*
- Q0 — security remediation · verified-by claude-verifier · 2026-07-07 *(merged to main 2026-07-07 — LONGVIEW run stopped by owner; NOTE: resuming LONGVIEW now requires BENNY_API_KEY in env or state/hmac-key keystore, fail-fast by design)*
- A9 — server-side call deadlines · verified-by claude-verifier · 2026-07-07 *(on main, released v1.12.6)*
- A8 — model-routing hygiene + ingest resilience · verified-by claude-verifier · 2026-07-07 *(on main, v1.12.3-5; known residual: lemonade health-probe shape, see LOG 2026-07-06T15:20)*

## BLOCKED (id · reason · date)
*(empty)*

## AUTHORED (contracts in tasks/, waiting on deps — W0 conversion 2026-07-07)
A1 A2 A3 A4 A5 A6 A7 ·
B2 B3 ·
W1 W2 W3 ·
G1 G2 G3 ·
C1 C2 C3 C4 C5 C6 C7 ·
D1 D2 D3 ·
E1 E2 ·
F1 F2 F3 F4 F5 F6 F7 F8 ·
Q2 Q3 ·
R0 R1 R2 R3 ·
M2-1 M2-2 M2-3 M2-4 M2-5 M2-6 M2-7 M2-8

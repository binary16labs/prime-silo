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

## VERIFY (awaiting non-author verification)
- T1 — clone Benny home to trainer · author claude (T480) · main · ready-for-verify 2026-07-23 *(human-signed; benny-home 725,659 files / ~30.28 GB runs off external D: — C: too small; memo-ray copied to canonical .mem0ray\data. `node scripts/gates/t1.mjs` GREEN: Node+Python resolvers agree on D:\benny-home, 61 cards / 278 sessions / 572 vectors read LOCAL, no desktop network. Gotchas: Store-python virtualizes %APPDATA% (use PRIME_SILO_HOME env), isolated node on User PATH. See docs/train/T1-clone-provenance.md + LOG. VERIFY ON THE T480 with D: plugged in.)*
- C3 — login + first-run retheme · author claude-opus · branch task/C3 @ f94830f · 2026-07-12 *(budget amended 300→1100 by owner directive — flagship scope, see LOG)*

## DONE (id · verified-by · date)
- T0 — prove RDNA4 eGPU QLoRA trainer · verified-by claude-t0-verifier · 2026-07-23 *(reproduced GREEN on the T480 gfx1200 eGPU from a fresh session: author artifacts moved to *.author-bak, smoke regenerated in trainer venv, gate re-run — gfx1200 / 15.9 GiB, steps=30, loss 2.2888→1.4939 decreasing, reloadable adapter, exit 0. Honest caveat: smoke used Llama-3.2-1B eager path per owner verifier instruction, not the BDD's Qwen2.5-Coder-7B — RDNA4 4-bit QLoRA capability is proven; base model is a smoke fixture. Unblocks T3's T0-dep; T3 still needs T2.)*
- C1 — adaptive layout contract · verified-by claude-sonnet-verifier · 2026-07-12 *(merged to main 2026-07-12 @ 1c0a19e; MANUAL 3-res screenshot deferred to post-merge preview — orchestrator; follow-up candidate: resizable-splits + localStorage persistence, prose-only in contract, never codified as a scenario)*
- C5 — mascot micro-states · verified-by claude-haiku-verifier · 2026-07-12 *(merged to main 2026-07-12 @ 77a3edd; open follow-up: one-line initMascotState() wire in onscreen_agent/panel.html — outside C5 allowlist)*
- A0 — verify real offload path · verified-by claude-verifier · 2026-07-08 *(merged to main 2026-07-08 — live-verification contract; qwen3.5-9B-FLM @16k proven, judge 10/10, phi4-roulette hard-guard in place)*
- G0 — unified run-event stream spec · verified-by claude-verifier · 2026-07-08 *(merged to main 2026-07-08)*
- C0 — design system contract · verified-by claude-verifier · 2026-07-08 *(merged to main 2026-07-08)*
- W0 — work-contract format + full backlog conversion · verified-by claude-verifier · 2026-07-07 *(merged to main 2026-07-07)*
- B0 — coordination ledger spec + validator · verified-by claude-verifier · 2026-07-07 *(merged to main 2026-07-07)*
- Q0 — security remediation · verified-by claude-verifier · 2026-07-07 *(merged to main 2026-07-07 — LONGVIEW run stopped by owner; NOTE: resuming LONGVIEW now requires BENNY_API_KEY in env or state/hmac-key keystore, fail-fast by design)*
- A9 — server-side call deadlines · verified-by claude-verifier · 2026-07-07 *(on main, released v1.12.6; OPEN follow-up A9.1 tracked — enricher/clustering await-inventory + sync chroma.add, see LOG 2026-07-08T11:45, ready for pickup)*
- A8 — model-routing hygiene + ingest resilience · verified-by claude-verifier · 2026-07-07 *(on main, v1.12.3-5; known residual: lemonade health-probe shape, see LOG 2026-07-06T15:20 + A8.3 probe-shape residual closed 2026-07-08)*

## BLOCKED (id · reason · date)
*(empty)*

## AUTHORED (contracts in tasks/, waiting on deps — W0 conversion 2026-07-07)
A1 A2 A3 A4 A5 A6 A7 ·
B2 B3 ·
W1 W2 W3 ·
G1 G2 G3 ·
C2 C4 C6 C7 ·
D1 D2 D3 ·
E1 E2 ·
F1 F2 F3 F4 F5 F6 F7 F8 ·
Q2 Q3 ·
R0 R1 R2 R3 ·
M2-1 M2-2 M2-3 M2-4 M2-5 M2-6 M2-7 M2-8 ·
T2 T3 T4  (EP-T/M3 — authored 2026-07-21)

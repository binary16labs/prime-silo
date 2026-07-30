# M3 — House-method model → **v2.2.0**

**Scope (committed, plan §T / rev 13):** EP-T implementation — T0 prove-trainer · T1 clone-home ·
T2 data-pipeline · T3 QLoRA + honest eval · T4 wire-into-Benny-router + offload. (T5 DPO/scale is
optional, deferred.)

**Trigger:** owner-approved design plan (`mellow-tinkering-swan.md`, 2026-07-21) + T480 hardware
brought online. Contracts authored at this checkpoint by Claude (frontier authoring).

**Dependencies out:** none blocking M1/M2 — EP-T is additive (new engine candidate behind the
existing router; RAG unchanged). Reuses EP-A's offload path (A0 DONE) at T4.

**Exit:** same DoD pattern as M1/M2 — phase gates (`scripts/gates/t0..t4`) + non-author verification

- KR1.5 scored ≥0.7 by its eval instrument + boot-verified release.

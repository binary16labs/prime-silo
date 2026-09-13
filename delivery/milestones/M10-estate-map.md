# M10 — The Estate Map → **v1.25.0**

**Scope (committed, design source `architecture/SOLUTION-estate-map.md`):** EP-S S0–S8. Prime-Silo on every
node maps files (MFT-fast adapters with a walker fallback), applications and media; the hub folds one estate map
exposed at `/api/estate/map` and rendered as the Estate Map panel; integrity (duplicates, sole copies, coverage,
verification) and a storage policy drive centralisation proposals that a human signs and a node executes.

**Trigger:** owner directive 2026-09-13 after a day of diagnosing and fixing the estate by hand-run scripts
(updater tag 404, ASUS remote access, NAS share). The scripts unblocked the estate; this milestone moves the
capability into the product and retires them.

**Dependencies out:** additive over EP-N (N5 governance, N7 register — both DONE), EP-L (L0 KEL, L1 CAS), the
artifact ledger, the inventory sweep and the NAS catalog (bb30d0a7). No default route changes (R36).

**Human-signed stops:** S1 (third-party MFT service install), S3 (network surface), S7 (moves data), S8
(elevation path).

**Exit:** phase gates `scripts/gates/s0..s8` + non-author verification + the plan §7 pre-registered criteria
reported with measured values. VISION-CHECK as EP-S.

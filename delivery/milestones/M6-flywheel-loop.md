# M6 — LONGVIEW flywheel: the closed loop + agent loops → **v2.5.0**

**Scope (committed, design source `architecture/SOLUTION-longview-self-learning.md` §7 wave 3):**
EP-L wave-3 — L10 flywheel-daemon (file-watch + cron trigger under the single-winner claim; full-hybrid
liveness) · L11 model-collapse guard (verifier gate + house-fraction cap) · L12 human-signed promotion +
rollback · L13 promotion decision function + additive eval growth · L14 compound-value triad dashboard.
This is the part that makes the system _self-learning_ rather than a bigger pipeline — where the sharp
safety/correctness guards live.

**Trigger:** waves 1–2 (M4/M5) delivering — the substrate (KEL, staging, delta, register, tagging,
claim) and the bi-temporal projectors are the loop's inputs. Contracts authored at this checkpoint by
Claude (frontier authoring); `authority: human-signed` items (L10–L13 — the loop, training guard, and
model promotion) await owner signature before execution, per the human-signed-stops doctrine.

**Dependencies out:** additive over M4/M5 and EP-T (T3/T4/T5 trainer + router). Reuses B0's single-winner
lease (via L7) for cross-machine mutual exclusion, the G0 run-event stream for liveness telemetry, and
the EP-T frozen eval instrument as the honest anchor. Breaks no default path (R36): the served model
never auto-swaps; promotion is human-signed with pin + rollback.

**Exit:** same DoD pattern as M1–M5 — phase gates (`scripts/gates/l10..l14`) + non-author verification +
wave-3 proven: the loop advances staged→synthesis→dataset→train→serve→agents→sessions and each turn is
measured against the frozen instrument (R23); a non-improving turn is logged, not hidden (R24); house
self-output is verifier-gated + fraction-capped before training (R38); promotion is human-signed with
rollback (R39) by an explicit decision rule (R44); the compound-value triad (eval delta + agent
pass-rate + cost/task) is visible over turns (R26). Closes EP-L. VISION-CHECK: which KRs moved
(KR1.5 model quality, KR2.2 unified stream) + one honest sentence on drift.

# EP-T — House-method model (train on code + LONGVIEW)

**Objective:** O1 · **Goals:** P1,P9 · **Milestone:** M3
**Plan source:** `../../architecture/PLAN-local-power-unified-ui.md` (workstream T — added rev 13; see LOG 2026-07-21)
**Design plan:** `~/.claude/plans/mellow-tinkering-swan.md` (rev 2026-07-21, owner-approved)

Distil *how we work* — not the facts — into a local model. A QLoRA fine-tune on the code +
LONGVIEW corpus teaches house method + voice (verify-before-commit, dry-run-first, additive design,
ADR/card structure) and how we drive tools; **RAG (S16/memo-ray/LONGVIEW) stays the fact source** at
inference. Not from-scratch pretraining; not cramming facts into weights. The model becomes a
candidate engine behind Benny's router and drives the ADR-004 offload path — additive, never a
replacement for the current engine.

**Hardware:** trainer = Lenovo T480 + Razer Core X eGPU + Sapphire Pulse RX 9060 XT 16GB
(RDNA4 / gfx1200), Windows host, ROCm-on-Windows + Unsloth. Serving via Benny (either box).

## Phases → task contracts
- [ ] `T0` — prove the trainer: ROCm-on-Windows + eGPU enumerates gfx1200 + 30-step QLoRA smoke on a 7B (FIRST; make-or-break hardware gate; WSL2/cloud fallbacks)
- [ ] `T1` — clone the Benny home to the trainer (Windows→Windows); stores read locally; home resolver green
- [ ] `T2` — data pipeline: `scripts/train/build_dataset.mjs` → Stream A (method/voice SFT) + Stream B (agent trajectories); leak-gate clean; held-out + gold sets
- [ ] `T3` — first QLoRA run + honest base-vs-tuned eval (RAG held separate); merge adapter → GGUF
- [ ] `T4` — wire tuned model behind Benny's router + drive the offload gate (additive, RAG-grounded, no regression)
- [ ] `T5` *(optional, later)* — DPO on verify-before-commit preference pairs; larger base / delta-refresh

## Exit
All phase gates green, verified by non-author agent; close with a VISION-CHECK note (plan §0.5):
which KRs moved (KR1.5, and KR1.2/KR1.3 if the tuned engine improves offload), measured evidence
(the base-vs-tuned eval delta — no unmeasured "trained on how we got there" claims), one honest
sentence on drift.

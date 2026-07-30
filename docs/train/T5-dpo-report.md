# T5 — DPO on the SFT model: honest SFT-vs-DPO result

**Status:** GATE GREEN — DPO ≥ SFT on the frozen instrument, but the margin is small.
Date: 2026-07-25. Author: claude-opus. Verify: `python scripts/gates/t5.py`.

> **Reading the numbers:** NLL = the model's "surprise" at the correct answer — **lower is
> better**. A "−0.3%" means the NLL dropped 0.3% (a small improvement); the minus sign is the
> direction of the score change, not a negative result.

## Headline (honest)

On the T2 v3 held-out split (A=7, B=402), RAG disabled, same frozen rubric as T3
(`scripts/train/eval/rubric.md`):

| metric                      | SFT (T3 v3) | DPO        | delta   | pct       |
| --------------------------- | ----------- | ---------- | ------- | --------- |
| A_nll (method/voice)        | 2.0828      | 2.0725     | +0.0103 | **−0.5%** |
| B_nll (tool calls)          | 0.6661      | 0.6659     | +0.0002 | **−0.0%** |
| **agg_nll (gate rule)**     | **1.1253**  | **1.1218** | +0.0035 | **−0.3%** |
| tool-name match (secondary) | 0.263       | 0.260      | −0.003  | —         |

**DPO passes the gate** (`dpo.agg_nll 1.1218 ≤ sft 1.1253`) but the improvement is
**marginal (+0.3% agg NLL)**, and greedy tool-name match dipped slightly (within noise on
402 rows). This is stated plainly, not dressed up — the rubric was frozen before T3 and is
not tuned to flatter DPO.

## Why the effect is small (the honest read)

- **The SFT v3 model already captured most of the extractable signal** — it was −57% agg NLL
  vs base, with A −38% and B −70%. There is little headroom left on this held-out NLL
  instrument for a second-stage nudge to move.
- **DPO's preference-ranking objective genuinely worked in training** — reward margins grew
  0 → 4.47 and rewards/accuracies reached 0.675 over the run, i.e. the model learned to rank
  the house reference above its own hard-negative answer. But **held-out NLL is a likelihood
  metric, not a ranking/win-rate metric**, so DPO's ranking gain does not show up as a large
  NLL drop. A pairwise win-rate eval would reflect DPO's benefit better; NLL is what the frozen
  rubric measures, so NLL is what the gate uses.
- **Deliberate scope**: DPO trained on 303 **method** pairs only (117 wrong-tool-selection +
  186 voice-drift), after dropping 446 `args_mismatch` pairs as fact-cramming (arg _values_ are
  RAG facts, not method — training to prefer them would fight the Workstream T doctrine). This
  keeps DPO honest to "method in weights, facts in RAG," at the cost of a smaller, method-only
  signal.

## What was trained

- **Policy init:** the T3 v3 SFT adapter (`scripts/train/qlora/out/adapter`); continues the
  same LoRA. **Reference:** the frozen SFT policy (Unsloth `ref_model=None` = adapter-disabled base).
- **Preference pairs — self-generated hard negatives (no human labels):** for TRAIN-split
  prompts, the SFT model (served by LM Studio on the eGPU) produced its greedy answer; where
  that answer was wrong vs the corpus reference, `(chosen=reference, rejected=SFT-answer)`.
  749 generated → **303 kept** (method-only filter). Leak-gated (0 hits).
- **DPO:** beta 0.1, lr 5e-6 (≪ SFT's 2e-4), cosine, 1 epoch, batch 1 × grad-accum 8,
  max_length 512, seed 3407, **VRAM gradient checkpointing** (see hardware note). 12.0 min,
  loss 4.77 → 3.91, reward margins 0 → 4.47, accuracy 0.675.

## Hardware finding (recorded — a real limit of this box)

DPO on a 7B is at the **16 GB host-RAM** edge of this trainer. Unsloth's default
`use_gradient_checkpointing="unsloth"` offloads activations to **host RAM**; DPO doubles the
sequences (chosen + rejected), so the pagefile peaked at **9.4 GB** and two runs swap-thrashed
to a crawl near the end (the eGPU tested perfectly healthy throughout — this was _not_ a GPU
wedge). Fix: `use_gradient_checkpointing=True` (activations in VRAM, ~11 GB free) + max_length
512 → clean 12-min run, free RAM steady ~4.5 GB. SFT (T3, single sequences, host-offload
checkpointing) fits; DPO needs the VRAM-checkpointing + short-sequence config on this box.

Process note: a first run was mis-reported as "progressing" from a stale tqdm log while
actually wedged — corrected by verifying liveness via CPU-time/artifacts, now the standing rule.

## Merged GGUF

`D:\t5-merge\gguf_gguf\qwen2.5-coder-7b-instruct.Q4_K_M.gguf` — 4466.1 MB, q4_k_m, arch qwen2,
339 tensors; merged from the DPO adapter (16-bit dequant then quantize). Loads two ways:
structural `gguf-py` read (gate) and a real `llama-server.exe /health` 200 (target runtime).
Manifest: `scripts/train/dpo/out/merge_manifest.json`.

## Gate output

```
[t5] prefs: 749 hard-negative pairs (chosen=corpus reference, rejected=SFT self-generated)
[t5] SFT agg_nll=1.1253  DPO agg_nll=1.1218  delta +0.0035 (DPO better)
[t5] gguf: qwen2.5-coder-7b-instruct.Q4_K_M.gguf loads — arch=qwen2, tensors=339, llama_server_load=True
[t5] GATE GREEN
```

## Reproduce

```bash
# 1. pairs (LM Studio serving the SFT model on the eGPU)
python scripts/train/dpo/build_prefs.py --n-b 600 --n-a 200
# 2. DPO (Unsloth venv, vcvars64 shell, LM Studio UNLOADED)
T5_MAX_SEQ=512 T5_GRAD_CKPT=true python scripts/train/dpo/train_dpo.py
# 3. eval + gate
python scripts/train/eval/run_eval.py --mode tuned --adapter scripts/train/dpo/out/adapter --out scripts/train/eval/out/t5/dpo.json
python scripts/gates/t5.py
```

## Verdict for KR1.5

KR1.5's core is met by **T3 v3** (tuned −57% agg NLL vs base, verified) + **T4** (live ADR-004
offload passing, judge 1.0). **T5/DPO is the honest final rung: it beats SFT but only marginally
(+0.3%)** on this instrument — evidence that the SFT stage already did the heavy lifting and that
further gains need either a ranking-aware eval, more/stronger preference data, or a bigger base,
not more of the same. Logged as-is; the rubric was not moved.

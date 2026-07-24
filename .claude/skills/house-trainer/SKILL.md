---
name: house-trainer
description: Operate the EP-T house-method QLoRA trainer end-to-end on the T480 eGPU — dataset builds (T2), training/eval/GGUF (T3+), verification, and the data-quality levers. Use when training, evaluating, rebuilding the dataset, verifying a T-task, or extending Workstream T.
---

# house-trainer — the EP-T QLoRA pipeline playbook

Everything here was proven live on the trainer (T0–T3, LOG 2026-07-22..24). Follow it and
you skip a week of Windows-ROCm debugging. **Read the two absolutes first.**

## Absolutes

1. **Privacy:** job-application/CV content NEVER enters training data. Every build runs
   the leak gate (`scripts/train/lib/privacy.mjs` → `scripts/longview/lib/leak_gate.mjs`).
   Quarantined sids (live home + sessions workspace `quarantine.json`) are dropped
   structurally. Generated rows are git-ignored — never commit them. Never weaken
   `scripts/train/dataset/personal_terms.json` to make a build pass.
2. **Honesty:** rubric (`scripts/train/eval/rubric.md`) is frozen BEFORE training. If a
   run invalidates an earlier number, the correction goes on the record
   (docs/train/T3-eval-report.md v1→v2 precedent). Tuned-worse is a valid, logged result.

## Environment (measured, don't rediscover)

- GPU: RX 9060 XT **gfx1200**, 15.92 GiB, Razer Core X TB3, native-Windows ROCm.
- Trainer venv python: `C:\Users\nsdha\.unsloth\studio\unsloth_studio\Scripts\python.exe`
  (torch 2.11.0+rocm7.13.0 / hip 7.13.99004 / Unsloth 2026.7.4 / bnb rocm714).
- **Training requires a vcvars64 shell** (Triton JIT): write a CRLF .bat that `call`s
  `C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat`
  then runs the venv python; launch from Git Bash as `cmd.exe //c '<single-quoted-path>'`
  (double slash beats MSYS path-mangling; never pipe the launch through `head`).
  Eager eval (`run_eval.py`) needs no vcvars.
- llama.cpp ROCm build: `~\.unsloth\llama.cpp\build\bin\Release\` (`llama-server.exe`,
  `llama-quantize.exe`); bundled `gguf-py` for structural reads. node: `~\.unsloth\node`.
- **Parallelism 1**: one GPU job at a time, batch 1 (+grad accum), workers 0.
- **Disk:** stage fp16 downloads + merges on D: (`HF_HOME=D:\t3-merge\hf`,
  `T3_GGUF_DIR=D:\t3-merge\gguf`) — ~30 GB peak for a 7B; C: cannot take it.
- Corpus: home clone `D:\benny-home` (PRIME_SILO_HOME), memo-ray `~\.mem0ray\data`
  (80,555 entities), big LONGVIEW workspace
  `D:\benny-home\benny\workspaces\sessions_v1` (376 JSON cards + data_out prose).

## Pipeline (each step gated)

```bash
# 1. Dataset (T2) — build + validate (leak gate, schema, disjoint split)
T2_TRACE_MAX_ENTITIES=80555 T2_TRACE_MAX_ROWS=5000 node scripts/gates/t2.mjs
node --test scripts/train/tests/build_dataset_test.mjs scripts/train/tests/build_dataset_v3_test.mjs

# 2. Gold sample for owner hand-audit (deterministic, stratified)
node scripts/train/audit_sample.mjs --n 200

# 3. Baseline eval FIRST (proves the instrument; re-run whenever the split changes)
<venv-python> scripts/train/eval/run_eval.py --mode base --out scripts/train/eval/out/base.json

# 4. Train (vcvars .bat wrapper; ~100 min for ~2.3k examples x 2 epochs)
T3_EPOCHS=2 T3_A_OVERSAMPLE=2 <venv-python> scripts/train/qlora/train_qlora.py

# 5. Tuned eval (same split, same instrument)
<venv-python> scripts/train/eval/run_eval.py --mode tuned --adapter scripts/train/qlora/out/adapter --out scripts/train/eval/out/tuned.json

# 6. Merge -> GGUF (STAGE ON D:) + gate
HF_HOME=D:\t3-merge\hf T3_GGUF_DIR=D:\t3-merge\gguf <venv-python> scripts/train/qlora/merge_gguf.py
python scripts/gates/t3.py   # GREEN iff tuned.agg_nll <= base.agg_nll AND GGUF loads
```

Timings: NLL-only eval (`--no-gen-match`) ~15 min; full eval with greedy tool-match ~1 h;
train ~100 min; merge ~1–1.5 h (dominated by fp16 download if not cached).

## Architecture invariants (why it looks the way it does)

- `scripts/train/qlora/format.py` is the ONE formatting module — training labels and eval
  NLL both come from `encode_nll` (prompt masked with -100). Never let them diverge, or
  the base-vs-tuned delta measures prompt drift, not learning.
- Training uses **plain HF Trainer over pre-tokenized rows**, NOT Unsloth's SFTTrainer
  dataset path — its multiprocess tokenize-map dies on Windows (spawn/dill can't import
  the generated UnslothSFTTrainer; `dataset_num_proc=1` doesn't help).
- Eager paths import `torchao_stub.py` before transformers (no Windows-ROCm torchao).
- Unsloth writes GGUFs to `<requested-dir>_gguf` — glob both.
- RAG stays DISABLED in eval — the number must be the fine-tune's own contribution
  (method in weights, facts in RAG; no KG fact-recall rows, no synthetic paraphrases).

## Data levers & current state

`docs/train/DATA-PLAN-v3.md` is the live plan; `docs/train/T2-dataset-card.md` has the
v1→v2 defect history (the 63%-empty-args lesson: **audit targets, not just schemas** —
median target length and duplicate-rate are the tells). Stream A sources are in
`scripts/train/lib/{corpus_v3,streams_v3}.mjs`; add a new source = new reader + pair
builder + red-first test + schema source.type + leak-gate wiring in build_dataset.mjs.
Rollups/KG = RAG material, never training rows.

## Verification protocol (author≠verifier)

Log as `claude-tN-verifier`. Reproduce, don't trust: re-run the NLL instrument fresh
(deterministic — must match to ~6 decimals), own split-overlap check, NEGATIVE tests
(swap base/tuned reports → expect RED tuned_worse; empty GGUF dir → RED gguf_missing;
seeded CV row → t2 RED), own llama-server /health smoke, then gate re-run. Move
VERIFY→DONE on the board + LOG with caveats stated (same-session verify is a named
caveat, precedent T2/T3).

## Current board state (2026-07-24)

T0/T1/T2/T3 DONE+verified. KR1.5 evidence: tuned Qwen2.5-Coder-7B **−62.5% agg NLL vs
base** (2.3153→0.8678, RAG off); GGUF `D:\t3-merge\gguf_gguf\qwen2.5-coder-7b-instruct.Q4_K_M.gguf`.
**T4 READY** (wire GGUF behind Benny router, additive, gate t4.py). Data-v3 rebuild in
flight; pre-registered criteria: A_nll delta ≤ −25% (was −9.2%) with B ≤ −50%, else the
conclusion is T5/DPO. Owner still owes the 200-row gold hand-audit (human-signed).

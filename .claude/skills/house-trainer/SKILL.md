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

## Liveness — NEVER trust a tqdm log for a long GPU job

The eGPU **wedges transiently** (TB3/RDNA4): a step hangs, the process stays alive but blocked,
working set collapses to ~MB, and the tqdm log freezes looking exactly like "slow". A DPO run
sat wedged at step 8/38 for 6 h this way. **Prove liveness, don't infer it:**
- log mtime vs now (`stat -c %y <log>`) — hours stale on a minutes-long job = wedged;
- two CPU-time snapshots ~90 s apart (`Get-CimInstance Win32_Process ... UserModeTime+KernelModeTime`)
  — a live job burns CPU seconds, a wedged one doesn't;
- advancing artifacts (trainer/checkpoint-*, *_result.json, adapter files).
Recover: `Stop-Process -Id <pid> -Force` (PowerShell; use `$procId`, `$id:` is a parse error) →
device-matmul health check → relaunch with a lower `max_length` (memory pressure wedges gfx1200).

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

## T4 — serving behind the router (LM Studio + eGPU)

Additive candidate: `runtime/benny/router/tuned_engine.py` registers `house/…` in MODEL_REGISTRY
+ wraps `resolve_executor` (default engine unchanged, reversible). Serve the GGUF via LM Studio
on the eGPU (copy into `~/.lmstudio/models/<pub>/<repo>-GGUF/`, `lms load <modelKey> --gpu max
--identifier <id>`; `lms import` hangs headless). Gate `scripts/gates/t4.py` = structural
(litellm-free) + live offload through the ADR-004 `run_task`. Gotchas: LM Studio 400s
`response_format:json_object` (fixed provider-agnostically in `offload/gate.py::run_judge`); use a
FAST non-reasoning judge (gemma-3-4b), different family from the executor (anti-collusion); never
run the live gate during a training run. See [[lmstudio-egpu-serving]].

## T5 — DPO (preference tuning)

Self-generated hard negatives: `scripts/train/dpo/build_prefs.py` asks the SERVED SFT model
(LM Studio) for greedy answers on TRAIN-split prompts; where wrong vs the corpus reference, emit
`(chosen=reference, rejected=SFT-answer)`. **Filter to method signal** — keep tool-selection
errors + voice-drift; DROP arg-value mismatches (that's memorising RAG facts, against the doctrine).
`train_dpo.py`: `PatchDPOTrainer()` first, load the SFT adapter as policy, `ref_model=None`,
beta 0.1, lr 5e-6 (≪ SFT's 2e-4), 1 epoch, max_length ≤1024. SFT baseline eval = reuse the last
SFT tuned.json (same adapter+split, deterministic). Gate `scripts/gates/t5.py`: GREEN iff
`dpo.agg_nll ≤ sft.agg_nll` + merged GGUF loads. DPO-not-beating-SFT is a valid logged result.

## Verification protocol (author≠verifier)

Log as `claude-tN-verifier`. Reproduce, don't trust: re-run the NLL instrument fresh
(deterministic — must match to ~6 decimals), own split-overlap check, NEGATIVE tests
(swap base/tuned reports → expect RED tuned_worse; empty GGUF dir → RED gguf_missing;
seeded CV row → t2 RED), own llama-server /health smoke, then gate re-run. Move
VERIFY→DONE on the board + LOG with caveats stated (same-session verify is a named
caveat, precedent T2/T3).

## Current board state (2026-07-25)

T0/T1/T2/T3 DONE+verified. **T3 v3** (data-plan-v3, all pre-registered criteria passed):
tuned Qwen2.5-Coder-7B **−57% agg NLL vs base** (2.6195→1.1253, A −38.3%, RAG off);
GGUF `D:\t3-merge\gguf_gguf\…Q4_K_M.gguf`, also in LM Studio as `qwen2.5-coder-tuned`.
**T4 DONE (in VERIFY)** — tuned wired behind the router, live ADR-004 offload passed, judge 1.0.
**T5 (DPO) in progress** — 303 method pairs, first run wedged (relaunched, max_len 1024).
Owner still owes the 200-row gold hand-audit (human-signed). KR1.5 closes on T5 verify.

# T3 — First QLoRA run + honest base-vs-tuned eval (KR1.5 evidence)

> **v3 addendum (2026-07-24, owner-directed data growth — DATA-PLAN-v3):** retrained on the
> 7,042-row v3 dataset (A 1,741+301 from six new house sources, B 4,201+799 full-corpus
> sweep). On the new 1,102-row held-out split, RAG disabled, same frozen rubric:
> **base agg_nll 2.6195 → tuned 1.1253 (−57.0%)**; A_nll −38.3% (v2: −9.2%), B_nll −70.5%,
> tool-name match 0.170 → 0.263. **All pre-registered criteria passed** (A ≤ −25%,
> B ≤ −50%, tool-match no regress — criteria were recorded in DATA-PLAN-v3 before the
> run). Honest conclusion: the data levers worked — the A-stream gap was data scarcity,
> not a method ceiling; DPO (T5, authored) is the next rung by choice, not necessity.
> Train: 7,683 examples (A ×2 oversample), 2 epochs, 330.8 min, loss 3.18 → ~1.08.
> The v3 GGUF supersedes v2 at the same path (`D:\t3-merge\gguf_gguf\`). The v2 numbers
> below stand as the verified T3 gate result; v3 is the current best artifact.

**Status:** tuned model beats base on the frozen rubric with RAG disabled. Date: 2026-07-24.
Author: claude (T3, claimed 2026-07-23). Verifier: re-run `python scripts/gates/t3.py`.

## Headline (the KR1.5 number)

On the T2 held-out split (A=7 method rows, B=402 trajectory rows — disjoint from train by
FNV-1a hash split), **RAG disabled**, scored by the rubric frozen *before* training
(`scripts/train/eval/rubric.md`, committed with the RED gate at `7fc1f0f`):

| metric | base | tuned | delta (base−tuned) |
|---|---|---|---|
| A_nll (method/voice) | 2.7671 | 2.5134 | **+0.2537 (−9.2%)** |
| B_nll (next tool call) | 2.3006 | 0.8143 | **+1.4864 (−64.6%)** |
| **agg_nll (token-weighted, the gate rule)** | **2.3153** | **0.8678** | **+1.4476 (−62.5%)** |
| tool-name exact match (secondary, greedy) | 0.221 | 0.264 | +0.043 |

GATE-GREEN rule: `tuned.agg_nll <= base.agg_nll` → **satisfied**. The tuned model assigns
~4.3× higher per-token probability (e^1.4476) to the house-style held-out completions.

## What was trained

- **Base:** `unsloth/Qwen2.5-Coder-7B-Instruct-bnb-4bit` (choice rationale in the rubric:
  code+method+tool-use domain, 7B 4-bit fits the 16 GB gfx1200 eGPU proven in T0).
- **QLoRA:** rank 16, lora_alpha 16, lr 2e-4, cosine, warmup 5%, adamw_8bit, seed 3407,
  4-bit base, LoRA on q/k/v/o/gate/up/down, **response-only loss** (prompt masked with the
  same `fmt.encode_nll` the eval uses — objective and instrument are token-identical),
  max_seq 2048 (rows are short; the plan's ~16k packing wastes VRAM here), batch 1 ×
  grad-accum 8 (parallelism-1 infra rule), **2 epochs**.
- **Data:** T2 dataset **v2** (see the v2 refresh section of `docs/train/T2-dataset-card.md`):
  Stream A 56 train ×4 oversample (voice signal vs 2098 B rows) + Stream B 2098 train =
  2322 examples. Leak gate 0 hits (14 terms / 0 sids); CV/job content excluded by
  construction. Eval split never loaded by the trainer.
- **Run:** 100.1 min wall on the RX 9060 XT (gfx1200, 15.92 GiB) over TB3, native-Windows
  ROCm (torch 2.11.0+rocm7.13.0 / hip 7.13.99004), Unsloth 2026.7.4 + plain HF Trainer
  (pre-tokenized — see gotchas). Loss 2.61 → ~0.82 (mean train loss).

## Honesty notes (read before quoting the number)

1. **The v1 run's result was partly an artifact and was superseded.** The first training run
   (v1 dataset, 480 rows) recorded base 2.5884 → tuned 1.0373 (−59.9%) and tool-name match
   0.25 → 0.71. The pre-v2 audit then found **63% of Stream B targets had empty args** (a
   `{name,input}`-format extraction bug) with degenerate `invoke X` goals — i.e. much of that
   improvement was learning to emit trivial `{"name":X,"args":{}}` strings. v2 fixed the
   extraction (0.1% empty args, 2.7% duplicate targets, 54 tools), rebuilt at 5× corpus
   (2563 rows), and re-ran BOTH sides on the identical new split. The v2 numbers above are
   the KR1.5 evidence; v1 is recorded here so the correction is on the record.
2. **Tool-name match is low in absolute terms** (0.264 tuned). It requires exact first-JSON
   `name` equality under greedy decode with only 4 ancestor steps of state — many held-out
   situations admit several reasonable next tools. It is secondary evidence by rubric design;
   NLL is the stable instrument.
3. **Stream A moved less than Stream B** (−9.2% vs −64.6%): 56 unique voice rows vs 2098
   trajectories — expected; growing Stream A (more cards/ADRs/method docs) is the T5/data-v3
   lever.
4. **RAG disabled** means these numbers measure the fine-tune's own contribution only, per
   the Workstream T design split (method in weights, facts in RAG). No KG fact-recall rows
   were added to training — deliberately.

## Merged GGUF (serving artifact for T4)

- **File:** `D:\t3-merge\gguf_gguf\qwen2.5-coder-7b-instruct.Q4_K_M.gguf` — 4466.1 MB,
  q4_k_m, arch `qwen2`, 339 tensors (adapter merged into 16-bit before quantization, so
  serving is not quantization-locked to the 4-bit training path).
- **Load proof, two ways:** structural read via the bundled `gguf-py` (gate check) AND a
  real `llama-server.exe /health` 200 from the ROCm gfx120X llama.cpp build (the T4 target
  runtime) — recorded in `scripts/train/qlora/out/merge_manifest.json` (`llama_server_load: true`).
- **Merge peak was staged entirely on D:** (`HF_HOME=D:\t3-merge\hf`, ~30 GB peak) after the
  first attempt exhausted C: — keep it that way on this box. Note Unsloth writes GGUFs into
  `<dir>_gguf` (suffix appended to the requested output dir).

## Gate output

```
[t3] base  agg_nll=2.3153  tuned agg_nll=0.8678  delta +1.4476 (tuned better)
[t3] gguf: qwen2.5-coder-7b-instruct.Q4_K_M.gguf loads — arch=qwen2, tensors=339, llama-server smoke=True
[t3] GATE GREEN
```

## Reproduce

```bash
# eval either side (Unsloth venv python; eGPU attached)
python scripts/train/eval/run_eval.py --mode base  --out scripts/train/eval/out/base.json
python scripts/train/eval/run_eval.py --mode tuned --adapter scripts/train/qlora/out/adapter --out scripts/train/eval/out/tuned.json
# gate
python scripts/gates/t3.py
# retrain (vcvars64 shell; ~100 min)
T3_EPOCHS=2 T3_A_OVERSAMPLE=4 python scripts/train/qlora/train_qlora.py
```

## Gotchas carried forward (Windows-ROCm trainer)

- Unsloth's compiled `SFTTrainer` tokenize-map spawns `multiprocess` workers that cannot
  import the runtime-generated `UnslothSFTTrainer` module on Windows (dill unpickle →
  `ModuleNotFoundError`), and `dataset_num_proc=1` does not avoid the pool. T3 pre-tokenizes
  with `fmt.encode_nll` and uses a plain HF `Trainer` + `DataCollatorForSeq2Seq` — which also
  guarantees train/eval masking parity.
- Training (Triton) needs the vcvars64 shell (T0 gotcha); the eager eval harness does not.
- torchao stub (`scripts/train/qlora/torchao_stub.py`) required on the eager path.
- Batch wrappers launched from Git Bash need `cmd.exe //c '<single-quoted path>'` (MSYS
  path-mangling) and CRLF line endings.

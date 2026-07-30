# T3 eval rubric — FROZEN before training (no moving goalposts)

> Committed with the RED gate, before any weights are updated. The QLoRA run does not
> get to see this file change. If the tuned model does not beat base under _these_ rules,
> that is an honest, logged result (T3 contract "Out of scope").

## What we measure

The held-out eval set is the **T2 held-out split**, disjoint from training by construction
(FNV-1a hash split, verified overlap=0 in T2):

- `scripts/train/dataset/stream_a.eval.jsonl` — **7 rows**, method/voice (instruction → house-style response)
- `scripts/train/dataset/stream_b.eval.jsonl` — **76 rows**, agent trajectory (state+goal → next tool call)

**RAG is disabled.** The model sees only the prompt (instruction, or state+goal). No retrieval,
no memo-ray, no LONGVIEW context is injected. The number therefore reflects the _fine-tune's own
contribution_ — internalized method + tool-use — not retrieval. This is the whole point of the
honest scope split (fine-tune = method/voice/tool-use; facts stay in RAG).

## Metrics

The prompt is built by the **same** `format_row()` used for training (`scripts/train/qlora/format.py`),
so eval and train agree on the chat template exactly. For each row we mask the prompt tokens and
score only the reference completion.

- **Primary — held-out NLL (cross-entropy).** Mean per-token negative log-likelihood of the reference
  completion under the model, prompt masked. Lower is better. This is the standard, deterministic,
  judge-free, network-free instrument. Reported per category:
  - `A_nll` — Stream A reference responses
  - `B_nll` — Stream B reference tool-call JSON
  - `agg_nll` — **token-weighted** mean over all A+B completion tokens (the single headline number)
- **Secondary evidence — tool-name exact-match rate (Stream B).** Under greedy (deterministic) decoding
  of a bounded number of tokens, does the model's first emitted tool call name equal the reference
  `tool_call.name`? Reported as `B_toolname_match` (0..1). Secondary because with 76 rows the rate is
  noisy; NLL is the stable gate instrument.

## Aggregate score

`aggregate = -agg_nll` (higher is better). Per-category deltas (`base - tuned`, positive = tuned
improved) are reported for transparency.

## GATE-GREEN condition (the only pass/fail rule)

**Tuned wins iff `tuned.agg_nll <= base.agg_nll`** — i.e. the tuned model assigns at least as much
probability to the house-style held-out completions as the base, over the full A+B token set, with
RAG disabled. Equivalently `aggregate_tuned >= aggregate_base`.

Plus the merged adapter must export to a GGUF that **loads** (structural load via the bundled
`gguf-py` reader: valid magic/version, architecture present, tensor count > 0; corroborated by a
real `llama-server.exe` load smoke recorded in the report).

Reason codes the gate can emit: `no_eval` (report missing/incomplete), `gguf_missing`,
`gguf_load_fail`, `tuned_worse` (tuned.agg_nll > base.agg_nll).

## Base model choice (recorded here, decided from T0 + domain fit)

**Qwen2.5-Coder-7B-Instruct.** Rationale: the corpus is code + development method + agent tool-use, which
is Qwen-Coder's domain; 7B (4-bit) fits the 16 GB gfx1200 eGPU proven in T0, where 8B leaves less head-
room for training activations. QLoRA loads the Unsloth pre-quantized `unsloth/Qwen2.5-Coder-7B-Instruct-bnb-4bit`
(same bnb-4bit path T0 proved with Llama-3.2-1B); the merge step dequantizes to 16-bit before LoRA merge
and GGUF export, so serving is not quantization-locked to training.

## Hyperparameters (from design plan Phase 2, recorded before the run)

QLoRA rank 16, lora_alpha 16, lr 2e-4, cosine schedule, 4-bit base. `max_seq_length` is set from the
VRAM budget and recorded in the eval report — our rows are short (instruction/response, tool-call
state), so the plan's "packed ~16k ctx" is unnecessary and would waste VRAM; we pack short rows and
cap the sequence length at the largest value that trains within 16 GB at parallelism 1. The exact
value used is in `docs/train/T3-eval-report.md`.

# Session report — Workstream T (house-method model), T3→T5 + KR1.5 close

**Dates:** 2026-07-23 → 2026-07-25. **Trainer:** Lenovo T480 + Razer Core X eGPU (TB3) +
Sapphire Pulse RX 9060 XT 16 GB (RDNA4 / gfx1200), native-Windows ROCm + Unsloth.
**Outcome:** EP-T epic (T0–T5) complete and independently verified; **OKR KR1.5 closed**.

> **Reading the numbers:** the score is **NLL** (how "surprised" the model is by the correct
> answer) — **lower is better**. A percentage like "−57%" means the NLL *dropped* by 57%, i.e. the
> model **improved** by that much. Negative = better here; it is never a "negative result".

## Scope delivered this session

Picked up after T0/T1/T2 were done, and carried Workstream T to completion:

| task | what | headline result | verified |
|---|---|---|---|
| **T3** | first real QLoRA fine-tune + honest base-vs-tuned eval | tuned beats base **−57.0% agg NLL** (v3 data) | ✅ 6-dp reproduction |
| **T4** | wire the tuned model behind Benny's router + drive the ADR-004 offload gate | live offload **passed**, judge 1.0, no regression | ✅ reproduction + negative tests |
| **T5** | DPO (preference tuning) on the SFT model | DPO beats SFT **marginally (+0.3%)** — honest | ✅ 6-dp reproduction |
| **data-plan v3** | grow + fix the training dataset | 563 → 7,042 rows; A-stream gain −9.2% → −38.3% | gate GREEN |

Everything followed the delivery board discipline: red-first gates, author≠verifier
(each task independently re-verified under a `claude-tN-verifier` identity), append-only LOG,
and honest results (the eval rubric was frozen before training and never tuned to pass).

## The three instruments (KR1.5 evidence)

Frozen rubric (`scripts/train/eval/rubric.md`, committed before any training): held-out
**NLL** (how much probability the model assigns to the real house answers) + a secondary
tool-name match, **with RAG disabled** so the number reflects the fine-tune's own contribution.

1. **T3 v3** — base 2.6195 → tuned **1.1253** agg NLL (−57.0%; method-voice −38.3%, tool-calls
   −70.5%), tool-name match 0.17 → 0.26. All pre-registered data-v3 success criteria passed.
2. **T4** — the tuned q4_k_m GGUF, served by LM Studio on the eGPU, registered as an *additive*
   candidate behind Benny's router (default engine unchanged), ran a real ADR-004 offload task:
   gemma-3-4b judge scored the output 1.0, task passed, honest ledger entry, no regression vs
   the current-engine baseline.
3. **T5** — DPO on 303 self-generated method hard-negatives: agg NLL 1.1253 → **1.1218**
   (+0.3%). Beats SFT, but marginally — a legitimate diminishing-returns result, logged as-is.

## Data-plan v3 (the biggest quality lever)

The owner asked to validate the data and improve the model. The audit found the v1 dataset was
**substantially broken**: 63% of tool-call training targets had empty arguments (a `{name,input}`
vs `{name,args}` extraction bug that flattened all Claude-format rows), degenerate "invoke X"
goals, and Stream A locked to a single instruction template. Fixed with red-first tests, then
grew the corpus from six new house-voice sources (376 sessions_v1 JSON cards, the delivery LOG,
task contracts, architecture docs, LONGVIEW book/dossier prose, and ~18k memo-ray Thought
entities). Result: **7,042 rows** (from 563), leak-gate 0 hits, and the weak method/voice stream
improved 4× (−9.2% → −38.3%). Privacy hardened: quarantined session ids now enforced structurally,
not just by term-matching. **No job-application/CV content ever entered training** (the standing
guardrail), and no knowledge-graph *facts* were crammed into weights (facts stay in RAG by design).

## Bugs found and fixed (each a real finding)

- **Dataset extraction (T2/v3):** Claude-format tool calls read as empty args (63% of Stream B);
  degenerate goals; template lock. Fixed; corpus 12× larger and cleaner.
- **Windows-ROCm training:** Unsloth's SFTTrainer tokenize-map dies on Windows `spawn` workers →
  switched to pre-tokenized data + plain HF Trainer (which also guarantees train/eval masking
  parity). torchao stub, `cmd.exe //c` + CRLF batch launches, and `<dir>_gguf` output-suffix all
  carried from earlier tasks.
- **GGUF merge disk:** a 7B fp16→GGUF merge peaks ~30 GB; the box's drives were 98% full. Staged
  the whole peak on D:.
- **T4 judge / LM Studio:** the ADR-004 judge sent `response_format:{type:json_object}`, which
  **lemonade accepts but LM Studio rejects with HTTP 400**. Provider-agnostic fix (retry without
  it); allowlist amended + logged; no regression on offload tests.
- **T5 DPO on a 16 GB host:** two runs died — first a transient eGPU wedge (step 8), then a
  **host-RAM swap-thrash** (pagefile peaked 9.4 GB) because Unsloth's default checkpointing
  offloads activations to *host* RAM and DPO doubles the sequences. Fix: VRAM checkpointing +
  max_length 512 → clean 12-minute run.

## Process correction (worth recording)

During the first DPO run I reported it "progressing" from a stale `tqdm` log while the process
was actually wedged; the owner challenged it ("are you sure it's not a false positive"). It was.
The standing rule now (saved to memory and the `house-trainer` skill): **prove a long GPU job's
liveness by CPU-time / advancing artifacts, never by the log line.**

## Artifacts

- Code: `scripts/train/{qlora,eval,dpo,lib}/`, `runtime/benny/router/`, gates `t3.py`/`t4.py`/`t5.py`.
- Evidence docs: `T3-eval-report.md`, `T4-integration.md`, `T5-dpo-report.md`, `DATA-PLAN-v3.md`.
- Models (on D:, git-ignored): T3 v3 and T5 DPO q4_k_m GGUFs; the DPO GGUF is the current best and
  is loadable in LM Studio as `qwen2.5-coder-tuned`.
- Repo skill `house-trainer` + persistent memory capture the full playbook so any agent can rerun
  or exceed this.

## Standing residual (human-signed)

The 200-row **gold hand-audit** (`scripts/train/dataset/gold_sample.jsonl`) — the owner reviews the
stratified sample; findings become builder exclusion rules before any future data pass. This is the
one open item; it does not block KR1.5.

## Verdict

KR1.5 — *"the house-method model measurably beats its base, honestly"* — is **met with a verified
number** (T3 v3 −57% agg NLL, RAG off), the model **serves behind the router** (T4 live offload),
and DPO is an honest **marginal** final rung (T5). The trainer is proven end-to-end on the T480 +
RDNA4 eGPU under native-Windows ROCm.

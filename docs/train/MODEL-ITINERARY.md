# Model itinerary — what to run, for what, on the eGPU (LM Studio)

The local model roster on the T480 + RX 9060 XT 16 GB eGPU, and what each is for — in
Prime-Silo (Benny's roles) and otherwise. **Serving rule: everything runs through LM Studio
on the eGPU** (`--gpu max`), OpenAI-compatible at `http://127.0.0.1:1234/v1`. Owner constraint:
LM Studio + eGPU only, one heavy model at a time (parallelism 1).

## At a glance

| model (LM Studio key) | size | best role | Prime-Silo mapping | eGPU |
|---|---|---|---|---|
| **qwen2.5-coder-tuned** *(our house model)* | 4.4 GB | house-method coding + agent tool-use | **offload executor / candidate engine** (T4); `house/…` router alias | ✅ fits |
| **google/gemma-3-4b** | 3.1 GB | fast judge + quick/low-latency tasks | **offload judge** (anti-collusion, proven T4); voice/speed role | ✅ fits |
| **qwen/qwen3.5-9b** | 6.1 GB | general planner / architect / SDLC | **default engine class** (`qwen3_5_9b`); no-regression baseline | ✅ fits |
| **deepseek/deepseek-r1-0528-qwen3-8b** | 4.7 GB | deep step-by-step reasoning | hard-analysis / "thinking" role (NOT judge — too slow) | ✅ fits |
| **google/gemma-4-12b-qat** | 6.7 GB | strong generation, quality-per-GB | **LONGVIEW card/graph generation**; vision | ✅ fits |
| **google/gemma-4-12b** | 7.0 GB | strong generation (non-QAT twin) | LONGVIEW generation alt; vision | ✅ fits |
| **openai/gpt-oss-20b** | 11.3 GB | highest-quality local reasoning | heavy planning / one-off deep tasks (VRAM-heavy) | ⚠️ tight |
| **google/gemma-4-26b-a4b-qat** | 14.6 GB | biggest-capability (MoE, 4B active) | top-tier synthesis when quality > speed | ⚠️ partial |
| **nomic-ai/…nomic-embed-text-v1.5** | 0.08 GB | text embeddings | **RAG vectorization** (primary) | ✅ fits |
| **cstr/…nomic-embed-text-v1.5** | 0.14 GB | text embeddings (GGUF) | RAG vectorization (alt/quantized) | ✅ fits |

*(eGPU column filled from the live check — see the verification table at the bottom.)*

## Prime-Silo role → recommended model

- **Offload executor (the house engine)** → `qwen2.5-coder-tuned` — the T3/T5 tuned model,
  registered behind Benny's router as `house/qwen2.5-coder-tuned` (additive candidate). This is
  the point of Workstream T: our method + tool-use, in weights; facts via RAG.
- **Offload judge (ADR-004 gate)** → `google/gemma-3-4b` — fast, non-reasoning, and a *different
  family* from the coder executor (anti-collusion, per ADR-004). Proven scoring 1.0 in T4. Never
  use a reasoning model as judge (it spends its budget thinking and times the gate out).
- **Default planner / architect / SDLC** → `qwen/qwen3.5-9b` — the current default engine class
  (`qwen3_5_9b` in `MODEL_REGISTRY`). Good general instruct + light reasoning; the current engine
  the tuned model is *additive* to, and the T4 no-regression baseline.
- **Deep reasoning / hard analysis** → `deepseek/deepseek-r1-0528-qwen3-8b` (thinks step by step)
  or `openai/gpt-oss-20b` when it fits — for genuinely hard problems where latency doesn't matter.
- **LONGVIEW generation** (session synthesis: cards, graph, book) → `google/gemma-4-12b-qat`
  (verified LONGVIEW generation model; QAT = best quality-per-GB). Set via `LONGVIEW_MODEL` /
  `BENNY_DEFAULT_MODEL`.
- **Vision** (figure/diagram/chart/table description) → gemma-3/gemma-4 are multimodal; use
  `google/gemma-3-4b` (fast) or `gemma-4-12b-qat` (quality) for the `vision` role.
- **RAG embeddings** → `nomic-ai/text-embedding-nomic-embed-text-v1.5` (tiny, always resident-able
  alongside an LLM).

## Non-Prime-Silo / general use

- Quick chat, drafting, low-latency helpers → `gemma-3-4b`.
- Long-form writing / summarization at quality → `gemma-4-12b-qat`.
- Anything needing the strongest local reasoning and you can spare the VRAM → `gpt-oss-20b`
  or `gemma-4-26b-a4b-qat` (expect slower + tighter memory).

## VRAM / co-residency notes (16 GB eGPU)

- Models ≤ ~7 GB (everything down to gemma-4-12b) load fully on the eGPU with headroom, and
  **two can co-reside** (e.g. the coder executor 4.4 GB + the gemma-3-4b judge 3.1 GB = ~7.5 GB —
  exactly the T4 offload setup). A third (qwen3.5-9b) fits at ~14 GB total but is tight.
- `gpt-oss-20b` (11.3 GB) fits alone with little headroom — load solo, small context.
- `gemma-4-26b-a4b-qat` (14.6 GB) will likely **partial-offload** (some layers to CPU) once you
  add context — not a strictly-eGPU-only model on 16 GB. Use only when its quality is worth the
  spill; prefer `gemma-4-12b-qat` for eGPU-only work.

## How to serve (always eGPU)

```bash
lms load <model-key> --gpu max -c <ctx> -y      # --gpu max = put all fittable layers on the eGPU
lms ps                                          # confirm DEVICE and that it's loaded
lms unload --all                                # free VRAM before loading a heavy model (parallelism 1)
# Benny/router reach it at the OpenAI endpoint:  http://127.0.0.1:1234/v1
```

To make the house model the router candidate (T4): it serves as `qwen2.5-coder-7b-instruct-house-tuned`;
`BENNY_TUNED_MODEL` + `BENNY_TUNED_BASE_URL=http://127.0.0.1:1234/v1` point the router at it.

## Live eGPU verification (2026-07-25)

Each model loaded with `lms load … --gpu max` and exercised on the eGPU (LLMs: a chat
generation; embeddings: the `/v1/embeddings` endpoint). Latency is first-response *including
cold load* (not steady-state speed), so it's a load+run proof, not a benchmark. Raw data:
`docs/train/egpu-model-check.tsv`.

| model | loaded on eGPU | ran | note |
|---|---|---|---|
| qwen2.5-coder-tuned | ✅ | ✅ gen | the house engine — fastest path |
| google/gemma-3-4b | ✅ | ✅ gen | judge/low-latency |
| qwen/qwen3.5-9b | ✅ | ✅ gen | default class |
| deepseek/deepseek-r1-0528-qwen3-8b | ✅ | ✅ gen | reasoning |
| google/gemma-4-12b | ✅ | ✅ gen | generation |
| google/gemma-4-12b-qat | ✅ | ✅ gen | generation (QAT) |
| openai/gpt-oss-20b | ✅ | ✅ gen | heavy — loads solo |
| google/gemma-4-26b-a4b-qat | ✅ | ✅ gen | heavy — `--gpu max` fit it; expect CPU spill with larger context |
| nomic-ai/…nomic-embed-text-v1.5 | ✅ | ✅ embed | **use this for RAG embeddings** |
| cstr/…nomic-embed-text-v1.5 | ✅ | ❌ no embed | the `/v1/embeddings` call returned nothing — prefer the nomic-ai variant |

**Verdict: all 8 LLMs + the nomic-ai embedding model load and run on the eGPU in LM Studio.**
The one exception is the `cstr` embedding GGUF (didn't serve embeddings) — use `nomic-ai` instead.
The two heaviest models (gpt-oss-20b, gemma-4-26b) load with `--gpu max` but leave little/no
headroom; keep them solo and expect some CPU spill once context grows.

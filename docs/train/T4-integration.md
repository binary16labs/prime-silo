# T4 — Tuned model wired behind Benny's router + offload (KR1.5 close)

**Status:** GATE GREEN. The house-method tuned model (T3 v3) is an **additive candidate**
behind Benny's router, served by **LM Studio on the eGPU** (owner constraint), and drives a
real task through the **ADR-004 offload gate** with a judged result. The current default
engine is unchanged. Date: 2026-07-24. Author: claude-opus. Verify: `python scripts/gates/t4.py`.

## What was built (additive — no core edits to models.py/local_executor.py)

`runtime/benny/router/tuned_engine.py`:
- `register_tuned_model()` — adds one `MODEL_REGISTRY` candidate entry (`house/qwen2.5-coder-tuned`,
  flagged `candidate: True`) + ensures the `lmstudio` provider. **Never** touches
  `BENNY_DEFAULT_MODEL`; refuses to become the default.
- `register_tuned_executor()` — wraps `local_executor.resolve_executor` so `house/` resolves
  to the LM Studio endpoint; **every existing prefix resolves exactly as before** (proven in
  the gate). Reversible (`unregister_tuned_executor`).
- `tuned_healthy()` — true only when LM Studio actually serves the tuned model id (its
  `/v1/models` returns 200 even when empty, so we check the list).
- `select_engine(default, prefer_tuned)` — the fallback: uses the tuned engine only when
  explicitly preferred **and** healthy; otherwise returns the default and logs. Never raises,
  even if the health probe itself throws.

The tuned engine is a stable router alias (`house/…`) decoupled from LM Studio's exact model
string, so a later artifact (DPO/T5) swaps in by re-pointing config, never code.

## Serving (LM Studio + eGPU only, parallelism 1)

The T3 v3 GGUF is served by LM Studio on the eGPU:

```
# placed into LM Studio's model tree (the interactive `lms import` hangs headless — copy directly):
C:\Users\nsdha\.lmstudio\models\house\qwen2.5-coder-tuned-GGUF\qwen2.5-coder-7b-instruct.Q4_K_M.gguf
lms load qwen2.5-coder-tuned --gpu max --identifier qwen2.5-coder-7b-instruct-house-tuned -c 4096 -y
lms load google/gemma-3-4b --gpu max -y     # anti-collusion judge (different family)
lms load qwen/qwen3.5-9b   --gpu max -c 4096 -y   # current-engine baseline
```

Three models co-resident ≈ 14.6 GB on the 16 GB eGPU. Config (env, `docs`-driven):
`BENNY_TUNED_BASE_URL=http://127.0.0.1:1234/v1`, `BENNY_TUNED_MODEL=qwen2.5-coder-7b-instruct-house-tuned`,
`BENNY_TUNED_GGUF=<path>`; gate judge/baseline via `BENNY_T4_JUDGE_MODEL` / `BENNY_T4_BASELINE_MODEL`.

## The gate (`scripts/gates/t4.py`)

**Structural (hermetic, runs anywhere — litellm-free):** additive registration proven on the
real functions (default unchanged, candidate present, pre-existing entry not mutated); resolver
additivity (`house/` resolves to an OpenAI-compatible executor, `lemonade/` still a
`LemonadeExecutor`); unhealthy-tuned → fallback to default, and a *raising* health probe is
treated as unhealthy (no crash); router unit tests 5/5.

**Live (LM Studio serving the tuned model):** the tuned engine executes a real generate task
through `run_task` (the ADR-004 orchestrator) → deterministic + judge gate → honest digest +
ledger entry; no-regression check runs the same prompt on the current-engine baseline.
Reason `endpoint_down` (honest) when the tuned model isn't loaded.

## Integration fix found + made (allowlist amended, logged)

The ADR-004 judge (`runtime/benny/core/offload/gate.py::run_judge`) sent
`response_format:{"type":"json_object"}` — **lemonade honors it, but LM Studio rejects it with
HTTP 400** (`must be 'json_schema' or 'text'`), so the judge failed and every task escalated.
Since the owner mandates the LM Studio serving path, the T4 allowlist was amended (Q0/A8
precedent) to include `gate.py` for a **provider-agnostic** fix: attempt the lemonade-optimal
`response_format` first, then **retry without it** (the `Return only JSON` system prompt +
last-JSON extraction work on both). Verified: with the fix, gemma-3-4b judges the tuned
model's output `score=1.0` on LM Studio. Lemonade behavior is unchanged (attempt 0 still fires).

## Live result (2026-07-24, gate GREEN)

```
[t4] structural OK — default=qwen3_5_9b unchanged; candidate house/qwen2.5-coder-tuned
     registered; resolver additive; fallback safe; units pass
[t4] live offload on the tuned engine (judge=lmstudio/google/gemma-3-4b)
[t4] offload outcome: status=passed tier=yellow
[t4] honest ledger entry: status=passed local_model=house/qwen2.5-coder-tuned
     completion_tokens=8 judge_score=1.0 collusion_flag=False
[t4] no-regression: baseline lmstudio/qwen/qwen3.5-9b produced non-empty output (32 chars)
[t4] GATE GREEN
```

- The tuned engine (v3 GGUF on the eGPU) executed a real generate task through the ADR-004
  orchestrator; the **gemma-3-4b judge scored it 1.0** (different family → clean anti-collusion,
  `collusion_flag=False`); the task **passed** with an honest ledger entry.
- No regression: the current-engine baseline (`qwen/qwen3.5-9b`) completed the same task.
- Router unit tests 5/5; offload judge-compat + calibration tests pass.
- Judge model tip: use a **fast non-reasoning** instruct model (gemma-3-4b) as judge —
  qwen3.5-9b (reasoning) spends its token budget thinking and timed the gate out (ADR-004 §5).

## Honest notes

- The live gate is not hermetic (A0 precedent): it needs the eGPU + LM Studio serving the
  tuned model. `endpoint_down` is a valid honest failure, not a soft pass.
- The **live benny registry mutation** (`register_tuned_model()` into the running server's
  `MODEL_REGISTRY`) is exercised where benny actually serves — the trainer box has only the
  Unsloth env (no litellm), so the gate proves the `register_tuned_model()` function additive
  on explicit dicts here and notes the live wiring runs on the benny server. This is the one
  seam not executed end-to-end on this box.
- Baseline = `qwen/qwen3.5-9b` as the current-engine class on the LM-Studio-only box; the
  registry's nominal default `qwen3_5_9b` maps to a lemonade FLM model that isn't served here.

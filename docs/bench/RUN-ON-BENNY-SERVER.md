# P4 — run the two-model bench on the benny server

The full P4 instrument (navigation's eight fields + the lineage DAG) needs the benny stack
(`litellm`, the pypes orchestrator, `openlineage`). That stack is **not on the serving/trainer
box** — this must run where benny actually serves. Everything below is staged on `task/P4`.

## What's already done

- **Subjects & roster:** `docs/bench/p4-roster.json` — `incumbent` (`house/qwen2.5-coder-tuned`) vs
  `gemma-e4b` (`lmstudio/google/gemma-4-e4b`), primary metric `tool_selection_accuracy`, `repeats: 3`.
- **Authoring spec:** `docs/bench/p4-authoring-spec.json` (for `pypes model-bench`).
- **Gate:** `scripts/gates/p4.py` — authored and **proven** (GREEN on a valid report; RED on a
  missing 8th field, an unledgered subject, or a subject absent from the DAG). Runs dep-free.
- **Producer:** `docs/bench/produce_p4_report.py` — folds both surfaces through the merged P2/P3
  code and writes the report in the schema the gate checks.

## Prerequisites on the benny server

1. `litellm`, pypes orchestrator, and `openlineage` importable (the benny runtime env).
2. Both subjects reachable through benny's model registry:
   - incumbent: `register_tuned_model()` active, with `BENNY_TUNED_BASE_URL` → the LM-Studio eGPU
     endpoint and **`BENNY_TUNED_MODEL=qwen2.5-coder-tuned`** (the id LM Studio actually serves —
     the registry default `qwen2.5-coder-7b-instruct-house-tuned` will 404 otherwise).
   - candidate: `lmstudio/google/gemma-4-e4b` resolves to the same LM-Studio endpoint.
   - Confirm both answer: `curl $BASE/models` lists them; a 1-token completion returns text.
3. A workspace root for run artifacts (the orchestrator writes `runs/<id>/events.jsonl` there).
4. An **SDLC manifest that exercises tool selection** — the operator picks the canonical one
   (a swarm/agentic manifest; the trivial data pipelines won't produce navigation metrics).

## Steps

```bash
# 1. AUTHORING surface (optional but recommended — fills the authoring block)
benny pypes model-bench docs/bench/p4-authoring-spec.json --save-report docs/bench/results/authoring.md
#   -> also save the per-subject trials JSON as docs/bench/results/authoring-trials.json
#      keyed {"incumbent": <trial>, "gemma-e4b": <trial>}

# 2. NAVIGATION surface + fold + ledger + report (one command)
python docs/bench/produce_p4_report.py \
  --roster    docs/bench/p4-roster.json \
  --manifest  <the SDLC manifest that exercises tool selection> \
  --workspace <benny workspace root> \
  --authoring docs/bench/results/authoring-trials.json   # omit if authoring block is left null

# 3. VERIFY — re-derives the verdict from the report, trusts nothing
python scripts/gates/p4.py
```

Expected: `[p4] GATE GREEN`. Per P6, only **2 of 8** navigation fields (`tool_selection_accuracy`,
`iteration_latency_ms_p95`) are derivable against today's orchestrator; the other six are recorded
**explicitly unmeasured** — that is honest and the gate accepts it. A negative result (E4B loses)
is a valid P4 outcome; record it as-is.

## Bringing it back

`docs/bench/results/` is under the OneDrive-synced repo, so the report syncs back here. Once
`scripts/gates/p4.py` is GREEN on the benny server, ping me — I'll move P4 to `ready-for-verify`
and it goes to an **independent** non-author verifier (P4 is the proof that closes EP-M, so its own
verification is not waived).

## Note from the here-smoke

A quick direct-inference smoke on the serving box (now removed) showed why `repeats: 3` and the real
`model_compare` scorer matter: a single hand-rolled shot flipped the incumbent to `parse_ok=0` on one
unlucky generation while its actual plan was valid. Do not rank on a single shot.

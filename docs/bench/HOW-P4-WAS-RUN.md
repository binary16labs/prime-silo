# P4 — how it was run (authoring surface, owner-signed amendment)

## What P4 measured

A real two-model bench, incumbent (`house/qwen2.5-coder-tuned`, house-tuned 7B) vs candidate
(`google/gemma-4-e4b`), on the **planning/authoring** task, via the real `pypes model-bench`
(`model_compare`) instrument. Both models served on LM Studio (eGPU) at `localhost:1234`.

Result (frozen rubric `sha256:431f8c268670915d`, primary metric `authoring.wall_seconds`, lower is
better):

| subject | wall | tokens | cost | quality |
|---|---|---|---|---|
| **incumbent** | **14.54s** | 1,808 | $0.0008 | 0.143 |
| gemma-e4b | 54.23s | 2,274 | $0.003 | 0.143 |

**Incumbent wins** — ~3.7× faster, ~4× cheaper. Quality tied (`quality_score` 0.143 both); the
rubric-quality fields (`has_required_ops`, `step_count`, `parse_ok`) were not computed without the
judge, so they are recorded **unmeasured**, not zero.

## The amendment (owner-signed, 2026-08-05)

P4's contract names the **navigation** instrument (`tool_selection_accuracy` over the agentic SDLC
loop). That instrument has **no manifest to run against on today's orchestrator**: the swarm template
(`dynamic_report_swarm.json`, schema-2.0 `plan` block) emits **zero G0 node events**, and data-pipeline
manifests run nodes but don't exercise the model's tool selection. `derive_metrics` needs
`node_progress` events carrying `detail.tool` plus a rubric mapping nodes→expected tools; nothing
produces them. This is an **instrument gap**, not a report defect — it echoes P6's own caveat that
only 2 of 8 metrics are derivable and the loop count is a structural constant.

Rather than block EP-M on that gap, the owner signed P4 onto the **authoring surface**. The
navigation block is recorded **`unavailable` with a reason** for both subjects — the gate REFUSES a
report that hides the gap behind a silently-empty block. **The navigation-instrument gap is spun off
as its own contract** (an agentic bench manifest + tool rubric wired to the G0 stream).

## Reproduce

```bash
# 1. the real authoring bench (needs the benny venv: litellm + the pypes stack)
python benny_cli.py pypes model-bench docs/bench/p4-authoring-spec.json    # -> $BENNY_HOME/runs/model-compare/<id>/results.json

# 2. fold into the P4 report (dep-free: stdlib + P2/P3 only)
python docs/bench/produce_p4_report.py --results <that results.json>

# 3. verify (dep-free)
python scripts/gates/p4.py            # -> [p4] GATE GREEN
```

The venv used here: `C:\Users\nsdha\.benny-venv` (`pip install -r runtime/requirements.txt`). The
serving/trainer box had no benny stack by design; it was provisioned into that venv so the bench
runs locally against LM Studio.

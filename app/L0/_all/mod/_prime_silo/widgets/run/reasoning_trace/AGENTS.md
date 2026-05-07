# AGENTS — `_prime_silo/widgets/run/reasoning_trace/`

## Purpose

Read-only view of the per-node LLM reasoning trace for a Studio run. Fifth
migrated widget under ADR-001 Phase C — third to call the runtime, and the
first to expose **agent thinking** (everything inside `<think>...</think>`
or tagless preambles, normalized by `runtime/benny/core/reasoning.py`).

The widget is for debugging and audit: when a run misroutes, was the LLM's
private reasoning aware of the constraint? Did a chain-of-thought reach the
right conclusion before the formatted answer truncated it? This widget
shows you that, without leaking it into the response surface that other
agents see.

## Files

| File                          | Owns                                                        |
| ----------------------------- | ----------------------------------------------------------- |
| `index.js`                    | `createReasoningTraceWidget(host, props, options)` factory. |
| `reasoning_trace.css`         | Card layout, status chip, scrollable reasoning `<pre>`.     |

## Manifest mapping

Maps to widget id `run.reasoning_trace` registered in [`runtime/benny/api/widget_routes.py`](../../../../../../runtime/benny/api/widget_routes.py):

```
authority:        read_only
frame_bindings:   [
  { field: "node_id", required: false }
]
props:
  run_id:    string  (required, studio execution id)
  workspace: string  (default "default")
  node_id:   string  (optional — when set, only that node's reasoning is shown)
  limit:     integer (default 200, 1..1000 — events scanned)
```

## How it talks to the runtime

```
widget.load() →
  runtimeFetch("/governance/events?run_id=…&event_type=NODE_EXECUTION_STATE&workspace=…&limit=…")
    → shell proxy strips /api/runtime, injects X-Benny-API-Key
    → runtime governance_routes.list_governance_events()
    → audit log → JSON { count, events: [...] }
  → widget filters events whose data.outputs.reasoning_trace is non-empty
```

Reasoning is captured upstream by `studio_executor.execute_llm_node`, which
calls `extract_reasoning()` on each LLM message and threads the result
through the node's `outputs` dict before `emit_node_execution_state` fires.
That means **no new runtime endpoint is needed** — the data is already in
the governance audit log; this widget is purely a different lens on the
same events the lineage_timeline widget reads.

The widget **does not** use `fetchAsAgent` — reasoning inspection is human
debugging, not an agent action.

## Rendering

- **Summary header** — "N reasoning traces for run `<run_id>`".
- **Per-node card** — node id chip, status chip (green/red/neutral),
  ISO timestamp, duration. Stable left border colour-codes the widget so
  it's distinguishable from lineage_timeline at a glance.
- **Reasoning body** — `<pre>` with `white-space: pre-wrap` so existing
  newlines render but long lines also wrap. Capped at 22em with internal
  scroll so a 5-page reasoning trace doesn't dominate the layout.
- **Empty state** — "No reasoning trace recorded for run `<run_id>`. The
  run may not have used an LLM node, or the model returned no `<think>`
  output." Distinguishes "no LLM" from "LLM returned no thinking" softly,
  without forcing a separate API call to disambiguate.

## Lifecycle

```js
import { createReasoningTraceWidget } from "./index.js";

const handle = createReasoningTraceWidget(hostEl, {
  run_id: "20260507-141200-studio",
  workspace: "default",
});

// Pin to a single node (e.g. when the user clicks one in lineage_timeline).
handle.update({ node_id: "llm-classifier" });

// Manual reload (e.g. after the run continues past a HITL pause).
await handle.refresh();

// Tear down.
handle.destroy();
```

`handle.traces` exposes the cleaned-up reasoning records (one per node);
`handle.rawEvents` returns the unfiltered NODE_EXECUTION_STATE events,
useful when a sibling widget wants to render a different lens (e.g.
duration histogram) without paying the proxy cost twice.

## Authority

`read_only` — agent may compose this widget into its own diagnostic
layouts. Keep in mind that exposing reasoning to other agents has
information-leakage implications; the manifest does not gate that, but
the layout author should.

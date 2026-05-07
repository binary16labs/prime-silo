# AGENTS — `_prime_silo/widgets/run/drilldown_table/`

## Purpose

Read-only tabular drill-down into a single Pypes step's checkpoint. Fourth
migrated widget under ADR-001 Phase C — second to call the runtime, and the
first to exercise the **Pypes data path** through the proxy. Validates that a
gold/silver checkpoint can be paged into the shell without re-running the
manifest.

## Files

| File                       | Owns                                                                |
| -------------------------- | ------------------------------------------------------------------- |
| `index.js`                 | `createDrilldownTableWidget(host, props, options)` factory.         |
| `drilldown_table.css`      | Header, stage chip, CLP card, sticky-header scroll table.           |

## Manifest mapping

Maps to widget id `run.drilldown_table` registered in [`runtime/benny/api/widget_routes.py`](../../../../../../runtime/benny/api/widget_routes.py):

```
authority:        read_only
frame_bindings:   [
  { field: "rows",            required: true },
  { field: "clp_annotations", required: false }
]
props:
  run_id:    string  (required, no "pypes-" prefix)
  step_id:   string  (required)
  workspace: string  (default "default")
  rows:      integer (default 50, 1..5000)
```

## How it talks to the runtime

```
widget.load() →
  runtimeFetch("/pypes/runs/{run_id}/steps/{step_id}?workspace=…&rows=…")
    → shell proxy strips /api/runtime, injects X-Benny-API-Key
    → runtime pypes_routes.drilldown()
    → CheckpointStore reads the step's parquet/feather snapshot
    → JSON { run_id, step_id, row_count, columns, clp_binding, stage, rows }
```

The widget **does not** use `fetchAsAgent` — drill-down is human inspection,
no scope header. The runtime treats `/pypes/runs/*/steps/*` as a regular
governance-API-key-gated read.

## Rendering

- **Header** — `<run_id> › <step_id>` with stage chip (bronze / silver / gold
  colour-coded) and row/column counts.
- **CLP card** — `process / skill / data` columns from the step's
  `clp_binding`. If absent, surfaces the same warning the `pypes inspect`
  command emits ("drill-back lineage is blind") — keeps the gap visible
  rather than silent.
- **Table** — sticky-header scrollable. Cells:
  - `null`/empty → muted `—`.
  - numbers → tabular-nums monospace for column alignment.
  - objects/arrays → JSON-stringified inside a chip; one row per record stays
    intact even when a column holds nested data.

## Lifecycle

```js
import { createDrilldownTableWidget } from "./index.js";

const handle = createDrilldownTableWidget(hostEl, {
  run_id: "20260507-103000-pypes",
  step_id: "gold_exposure",
  workspace: "pypes_demo",
  rows: 200
});

// Re-bind to a sibling step.
handle.update({ step_id: "silver_trades" });

// Manual reload (e.g. after a `pypes rerun`).
await handle.refresh();

// Tear down.
handle.destroy();
```

`handle.rows`, `handle.columns`, and `handle.clpBinding` expose the last
loaded payload. Useful for sibling widgets (e.g. a chart) that want to
render the same data through a different lens without paying the proxy cost
twice.

## Authority

`read_only` — composable into agent-authored layouts. The two required
props (`run_id`, `step_id`) keep the widget useful only when the layout
binds it to a real run; an unbound instance surfaces an explanatory error
state rather than fetching `/undefined/undefined`.

# AGENTS — `_prime_silo/widgets/run/lineage_timeline/`

## Purpose

Read-only timeline of triple-lineage events for a single run. Third migrated widget under ADR-001 Phase C — and the **first widget that calls the runtime outside the sandbox** surface, which validates that the proxy + governance API key chain works for the broader read API.

## Files

| File                     | Owns                                                                          |
| ------------------------ | ----------------------------------------------------------------------------- |
| `index.js`               | `createLineageTimelineWidget(host, props, options)` factory.                  |
| `lineage_timeline.css`   | Timeline rail, event-type colour coding, integrity chip styles.               |

## Manifest mapping

Maps to widget id `run.lineage_timeline` registered in [`runtime/benny/api/widget_routes.py`](../../../../../../runtime/benny/api/widget_routes.py):

```
authority:        read_only
frame_bindings:   [{ field: "run_id", required: true }]
props:
  run_id:    string  (required)
  workspace: string  (default "default")
  limit:     integer (default 100, 1..1000)
  eventType: string  (optional — e.g. "AGENT_AUTHORSHIP")
```

## How it talks to the runtime

```
widget.load() →
  runtimeFetch("/governance/events?workspace=…&run_id=…&limit=…")
    → shell proxy strips /api/runtime, injects X-Benny-API-Key
    → runtime governance_routes.list_governance_events()
    → audit.read_audit_events()
    → newest-first JSON list of events
```

The widget **does not** use `fetchAsAgent` — this is human-driven inspection, not agent-authored mutation. No scope header is set. The runtime's existing governance API key check at the shell edge is the only authn that fires.

## Event rendering

Each event becomes a row with:

- **Timestamp** — left-aligned, monospace.
- **Event type** — colour-coded chip. AGENT_AUTHORSHIP → purple. SECURITY_* → red. Others → blue.
- **Integrity chip** — green "verified" if `_integrity_hash` present (matches Benny's audit-log integrity model from `verify_audit_integrity`); amber "unverified" otherwise.
- **Triple breakdown** — `process / skill / data` (and `outcome` when present), pulled from either `data.<field>` or `data.details.<field>` for resilience to schema drift across event types.

Missing fields render as `—` rather than `(missing)` to keep the timeline visually scannable; the dense kv-table look stays in `frame_inspector`.

## Lifecycle

```js
import { createLineageTimelineWidget } from "./index.js";

const handle = createLineageTimelineWidget(hostEl, {
  run_id: "run-cmr-v1",
  workspace: "default",
  limit: 200
});

// Re-bind to a different run.
handle.update({ run_id: "run-cmr-v2" });

// Manual reload after a new event lands (e.g. user just promoted a draft).
await handle.refresh();

// Tear down.
handle.destroy();
```

`handle.events` exposes the last-loaded array, useful for layout tiles that
also want to show a count or filter the same data differently.

## Authority

`read_only` — composable into agent-authored layouts. The widget's runtime call uses `runtimeFetch` (no scope header). If a layout binds a `run_id` that the workspace governance log doesn't know about, the response is an empty list and the widget renders an explanatory empty state — not an error.

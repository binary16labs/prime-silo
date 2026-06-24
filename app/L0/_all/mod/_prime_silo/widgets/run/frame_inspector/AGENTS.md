# AGENTS — `_prime_silo/widgets/run/frame_inspector/`

## Purpose

Read-only structured renderer for a Cognitive Frame. Second migrated widget under ADR-001 Phase C.

The widget is a **pure renderer** — it never fetches anything itself. The layout binds a frame object to props (`frame_bindings: [{ field: ".", required: true }]`) and passes it in. That keeps this widget out of the runtime-call lane entirely; it can render fixtures the same way it renders live frame outputs.

## Files

| File                  | Owns                                                                   |
| --------------------- | ---------------------------------------------------------------------- |
| `index.js`            | `createFrameInspectorWidget(host, props)` factory.                     |
| `frame_inspector.css` | Section-styled details/summary chrome plus assertion/confidence pills. |

## Manifest mapping

Maps to widget id `run.frame_inspector` registered in [`runtime/benny/api/widget_routes.py`](../../../../../../runtime/benny/api/widget_routes.py):

```
authority:        read_only
frame_bindings:   [{ field: ".", required: true }]
props:
  frame:            object   (the Cognitive Frame — required)
  initialCollapsed: SectionId[]   default ["raw"]
  showRawJson:      boolean       default true
```

`SectionId` is one of `header | assertions | withdrawal | provenance | confidence | raw`.

## Sections

The renderer structures the frame into six collapsible sections matching PRD §9 / NFR-05 vocabulary:

1. **Identity** (`header`) — `frame_id`, `frame_hash`, timestamps, source run/node.
2. **Assertions** — typed claims with `entity`, `claim`, `confidence`, `basis`.
3. **Withdrawal register** — `cannot_represent`, `contradictions`, `failure_register_refs`. Missing register flagged in red as a NFR-05 / FRAME_INVALID violation.
4. **Provenance** — `process`, `skill`, `incentive_context`, `parent_run_id`, plus `port_provenance` rows.
5. **Confidence** — calibrated score with optional drift signal.
6. **Raw JSON** — the whole frame, escape-hatched. Hidden by default to keep the inspector readable.

## Defensive rendering

Frames in the wild are messier than the schema demands — historic runs, partial fixtures, in-progress drafts. The renderer never throws on missing fields:

- Missing scalars render as `(missing)` in muted italic.
- Empty strings render as `(empty)`.
- Arrays accept either array form or single-value form.
- A missing `withdrawal` register is the one case that surfaces in red, because it is a hard NFR-05 violation per the PRD.

## Authority

`read_only` — composable into agent-authored layouts. The widget never calls `fetchAsAgent` or any sandbox endpoint, so there is nothing to scope.

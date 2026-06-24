# AGENTS — `_prime_silo/widgets/text/markdown/`

## Purpose

First-migrated widget under ADR-001 Phase C.

Renders an `agent_sandbox/notes/<filename>` markdown file, with optional save-back through the agent scope. The widget exists primarily to prove the full chain — registry resolution → runtime client → fetchAsAgent → AgentScopeMiddleware → lineage emission — works end-to-end on a low-risk surface before we migrate the heavyweight canvases (KG3D, dag.canvas, drill-down).

## Files

| File           | Owns                                                           |
| -------------- | -------------------------------------------------------------- |
| `index.js`     | `createMarkdownWidget(host, props, options)` factory.          |
| `render.js`    | Pure-function markdown → HTML renderer. Zero dependencies.     |
| `markdown.css` | Theme-friendly styles (uses `currentColor` and rgba neutrals). |

## Manifest mapping

Maps to widget id `text.markdown` registered in [`runtime/benny/api/widget_routes.py`](../../../../../../runtime/benny/api/widget_routes.py):

```
authority:    read_write_sandbox
props:        { source: string, workspace?: string }
frame_bindings: []  (this widget reads its source directly, not from a frame)
```

`source` is a _filename_ relative to `agent_sandbox/notes/` — not a path. The runtime rejects path separators in the filename.

## Authority + safety

- Authority is `read_write_sandbox`, so the widget is composable into agent-authored layouts.
- All writes go through `runtime_client.fetchAsAgent` — `X-Benny-Agent-Scope: sandbox` is set automatically. A misconfigured layout that points `source` at something outside the sandbox would be rejected by `AgentScopeMiddleware` with HTTP 403; the widget surfaces that detail to the user via the error state.
- The renderer HTML-escapes every input character before reintroducing markup, and rejects `javascript:` / `data:` hrefs in `[text](href)` links. Markdown content is treated as untrusted text.

## Lifecycle

```js
import { createMarkdownWidget } from "./index.js";

const handle = createMarkdownWidget(hostEl, {
  source: "exposure.md",
  workspace: "default"
});

// Re-render when props change (e.g. layout switches the bound note).
handle.update({ source: "credit_review.md" });

// Save edits back to the sandbox.
await handle.save("# Edited body");

// Tear down on tile unmount.
handle.destroy();
```

## What this widget does NOT do

- No editor UI. The save() entrypoint exists for the layout shell to call;
  the inline editor experience is owned by Phase F when `.aamp.view`
  bundles get authoring.
- No syntax highlighting in code blocks (Phase G if anyone needs it).
- No GFM tables, footnotes, or task lists. The renderer is intentionally
  the smallest subset that handles agent-authored notes today.

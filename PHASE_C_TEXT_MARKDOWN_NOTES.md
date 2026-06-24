# Phase C — first widget migrated (`text.markdown`)

This branch (`phase-c-text-markdown-widget`) migrates the first widget from the Phase A registry into the shell. It is the smallest possible end-to-end exercise of the chain Phase D wired up:

```
widget code  →  fetchAsAgent  →  /api/runtime/agent_sandbox/...
             →  AgentScopeMiddleware  →  emit_agent_authorship  →  done
```

## What landed

| Layer   | File                                                                                            |
| ------- | ----------------------------------------------------------------------------------------------- |
| Runtime | `runtime/benny/api/agent_sandbox_routes.py` — added `GET /read/{workspace}/{subdir}/{filename}` |
| Runtime | `runtime/tests/api/test_agent_sandbox.py` — 7 new tests for the read endpoint                   |
| Widget  | `app/L0/_all/mod/_prime_silo/widgets/text/markdown/render.js` — pure-function MD renderer       |
| Widget  | `app/L0/_all/mod/_prime_silo/widgets/text/markdown/index.js` — `createMarkdownWidget` factory   |
| Widget  | `app/L0/_all/mod/_prime_silo/widgets/text/markdown/markdown.css`                                |
| Widget  | `app/L0/_all/mod/_prime_silo/widgets/text/markdown/AGENTS.md`                                   |
| Tests   | `tests/widgets_text_markdown_test.mjs` — 9 cases (renderer + widget factory)                    |

## Why `text.markdown` first

Three reasons made this widget the right Phase C opening move over KG3D:

1. **Authority is `read_write_sandbox`.** Exercises both the read path and the agent-scoped write path in one widget. KG3D would only exercise reads.
2. **Zero rendering dependencies.** The renderer is a small pure function (~150 LOC). KG3D depends on Three.js + a DOM canvas + concept layout code that is not yet in the shell.
3. **Trust envelope friendly.** HTML escaping and href filtering are easy to reason about and easy to test. KG3D's render path has more attack surface.

Once the chain is proven on this surface, the heavyweight canvases (KG3D, dag.canvas, drill-down, frame inspector, lineage timeline) follow with confidence.

## Verification

```powershell
# Runtime — 38 tests (was 31 + 7 new for /read)
cd runtime
python -m pytest tests/api/test_agent_sandbox.py tests/core/test_workspace.py -q

# Shell — 19 cases across 3 test files
cd ..
node tests/runtime_proxy_test.mjs        # 5 cases
node tests/widget_registry_test.mjs      # 5 cases
node tests/widgets_text_markdown_test.mjs # 9 cases
```

End-to-end (requires running shell + runtime via `scripts/dev.ps1`):

```powershell
# Seed a note as the agent — confirms the write path works.
curl -X POST http://localhost:<shell-port>/api/runtime/agent_sandbox/write `
  -H "X-Benny-Agent-Scope: sandbox" `
  -H "Content-Type: application/json" `
  -d '{\"workspace\":\"default\",\"subdir\":\"notes\",\"filename\":\"hello.md\",\"content\":\"# Hello world\"}'

# Read it back — confirms the read path works.
curl http://localhost:<shell-port>/api/runtime/agent_sandbox/read/default/notes/hello.md
```

## What this proves

- The widget registry → runtime client → proxy → AgentScopeMiddleware chain
  works for both reads and writes.
- The agent-authority gate (`isAuthorityAgentSafe`) and the runtime gate
  (`AgentScopeMiddleware`) agree — `text.markdown` is `read_write_sandbox`,
  composable, and writes are confined to `agent_sandbox/`.
- The lineage emitter fires on every write: an `AGENT_AUTHORSHIP` event lands
  in the workspace governance log with `process=agent_authorship`,
  `skill=text.markdown`, `data=agent_sandbox/notes/<file>`.
- The shell can host a widget with zero React and zero build step.

## Upstream sync note

The `runtime/benny/api/agent_sandbox_routes.py` change should also land on
`skybluecycology/benny` master per `runtime/docs/operations/FORK_PROCEDURE.md` §8.
That cherry-pick is blocked by the same Git Credential Manager mix-up Phase B
flagged. Doesn't block iteration here — the fork's `runtime/` carries the
change today.

## Next

Phase C continues with the next widget. Recommend order based on shell-side
work cost:

1. `run.frame_inspector` — read-only structured-data view; close shape to `text.markdown`.
2. `run.lineage_timeline` — read-only timeline over the triple-lineage store.
3. `run.drilldown_table` — table view of Pypes node outputs with CLP annotations.
4. `kg3d.synoptic_web` — needs a Three.js dependency decision (vendored vs. CDN-loaded).
5. `dag.canvas` — last because it is `deterministic_only` and has the most
   complex prop schema; useful to validate the scope-rejection path with real
   widget code.

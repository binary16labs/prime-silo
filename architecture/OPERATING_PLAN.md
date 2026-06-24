# Prime-Silo Operating Plan

How to run, test, and ship work in `binary16labs/prime-silo`.

Cross-references:

- [ROADMAP.md](ROADMAP.md) — _what_ is being built and in what order.
- [ADR-001](../runtime/architecture/ADR-001-prime-silo-shell-fork.md) — _why_.
- [OPERATING_MANUAL.md](OPERATING_MANUAL.md) — _how to operate the shipped features_ (setup from scratch, feature walkthroughs, diagnostic playbook). The audience is the operator; this file's audience is the next phase contributor.

## Repo layout (the parts that matter to a phase delivery)

```
prime-silo/
├── app/                              # space-agent shell (browser-side)
│   └── L0/_all/mod/_prime_silo/      # this fork's browser code
│       ├── runtime_client/           # /api/runtime/* fetch + scope chokepoint
│       ├── agent_runtime/            # mountAgentTurn — agent's call surface
│       └── widgets/                  # migrated canvas widgets
├── server/                           # Node.js shell server (proxy lives here)
├── tests/                            # browser-side .mjs tests (node, no jsdom)
├── runtime/                          # Benny — vendored as a subtree, ADR-001
│   ├── benny/                        # FastAPI runtime; edit-in-place per phase
│   ├── tests/                        # pytest suite
│   └── architecture/                 # ADRs and design notes
└── architecture/                     # shell-fork-level docs (this file lives here)
```

The `runtime/` subtree is from `skybluecycology/benny`. It is edited in-place when a phase touches the runtime — `runtime/benny/api/widget_routes.py`, `runtime/benny/api/views_routes.py`, etc. Subtree pulls happen out-of-band; not part of phase delivery.

## Test runbook

### Browser tests (.mjs, plain Node)

```bash
# from prime-silo/
node tests/runtime_proxy_test.mjs
node tests/widget_registry_test.mjs
node tests/widgets_<scope>_<name>_test.mjs
node tests/runtime_client_agent_scope_test.mjs
node tests/agent_runtime_test.mjs
node tests/runtime_client_saved_views_test.mjs
node tests/runtime_client_view_signing_test.mjs
```

Each test file is self-contained and exits non-zero on failure. No test runner, no jsdom — they stub `globalThis.fetch` and assert against the wire.

To run the full Phase D + widgets regression set in one shot:

```bash
for t in runtime_proxy widget_registry \
         widgets_text_markdown widgets_run_reasoning_trace \
         widgets_run_lineage_timeline widgets_run_drilldown_table \
         widgets_run_frame_inspector widgets_kg3d_synoptic_web \
         widgets_codegraph_canvas \
         runtime_client_agent_scope agent_runtime \
         runtime_client_saved_views runtime_client_view_signing; do
  echo "--- $t ---"
  node tests/${t}_test.mjs || echo "FAIL: $t"
done
```

### Runtime tests (pytest)

```bash
# from prime-silo/runtime/
python -m pytest tests/api/ -v
python -m pytest tests/agentamp/ -v
python -m pytest tests/api/test_views_signing.py -v   # Phase F gate
python -m pytest tests/api/test_agent_sandbox.py -v   # Phase A/D2 gate
```

The full pytest suite has unrelated collection errors in some modules (kg3d, mcp, ops, sdlc, etc.) that pre-date this fork. Scope to the touched directories per phase.

### When to run what

| Change                                              | Run                                                                                                                       |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Widget under `app/L0/_all/mod/_prime_silo/widgets/` | the matching `widgets_*_test.mjs` + `widget_registry_test.mjs`                                                            |
| Runtime client (`runtime-client.js`)                | all four `runtime_client_*_test.mjs` + `agent_runtime_test.mjs` + every widget test (they all consume the runtime client) |
| Agent runtime (`agent-runtime.js`)                  | `agent_runtime_test.mjs` + `runtime_client_agent_scope_test.mjs`                                                          |
| Runtime API (`runtime/benny/api/*`)                 | matching pytest under `runtime/tests/api/` + the browser test of any consumer                                             |
| Shell proxy (`server/lib/runtime_proxy.js`)         | `runtime_proxy_test.mjs` + smoke any widget test                                                                          |

## Dev loop per phase

1. **Sync.** From `main`: `git fetch origin && git checkout main && git pull origin main`.
2. **Branch.** Convention: `phase-<id>-<short-handle>`. Examples: `phase-d3-saved-views`, `phase-f-aamp-view-signing`. Hyphen-cased, no slashes.
3. **Implement.** Edit code + tests + `AGENTS.md` in the same commit. Update [ROADMAP.md](ROADMAP.md) phase status if the phase finishes.
4. **Test locally.** Use the runbook above for the touched scope. Don't push without green tests for the touched scope.
5. **Commit.** Single commit per PR with a body that names what shipped, why, and which test surfaces are now green. Use a HEREDOC so the body formats correctly under Windows shells.
6. **Push.** `git push -u origin <branch>`. The Git Credential Manager (GCM) UI may prompt for sign-in on Windows — if the push hangs, alt-tab to GCM and click through.
7. **PR.** Use the URL from the push output. Title mirrors the phase: `phase-<id>: <one-line outcome>`.
8. **Merge.** User merges via GitHub UI.
9. **Repeat from step 1.**

## Branch + commit hygiene

- Never amend a merged commit.
- Stage explicitly with file lists, not `git add .`. The `runtime/benny.bat` and `runtime/benny.sh` scripts get local-only Python interpreter path edits that must NOT enter the commit.
- Never push `--force` to `main`. Force-push to a feature branch is fine if the user OKs it.
- Never bypass hooks (`--no-verify`).

## Local-only files to keep out of commits

| File                                    | Why                                                             |
| --------------------------------------- | --------------------------------------------------------------- |
| `runtime/benny.bat`, `runtime/benny.sh` | Hard-coded Python interpreter paths for the operator's machine. |
| `BENNY_HMAC_KEY` exports in shell rc    | Secret. Stays in env, never in repo.                            |
| `$BENNY_HOME/` contents                 | Workspace state — already gitignored.                           |

## Common gotchas

- **Push hangs** — GCM popup is waiting for click. Run pushes with `run_in_background: true` and a wakeup so the foreground stays responsive.
- **`git checkout main` reverts on-disk shell files** — expected. Feature branches carry the work; `main` snaps back to its merged state.
- **Pytest can't import `benny`** — run from `runtime/`, not the repo root. The `pyproject.toml` rootdir is set there.
- **Browser tests fail on `URL` import** — node ≥18 required. The tests use the WHATWG URL global.
- **Widget shows blank** — widget host missing; tests construct one via `createFakeHost(...)`. In dev, a real DOM element is needed.

## Memory + carry-over between sessions

- This file + [ROADMAP.md](ROADMAP.md) are the durable context. Read them first when reopening the project.
- Per-AGENTS.md docs are scoped to their folder and updated alongside code.
- Claude Code's `~/.claude/projects/.../memory/` is _supplementary_ — pointers to these docs, not duplicates. The repo wins on conflict.

## Release gates not in scope here

The runtime ships its own release gates (`G-COV`, `G-SR1`, `G-LAT`, `G-ERR`, `G-SIG`, `G-OFF`) under `runtime/tests/release/`. They run against Benny, not against the shell. A shell phase that touches Benny should still leave those green; gating is the runtime team's responsibility.

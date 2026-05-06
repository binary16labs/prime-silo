# Phase B — fork bootstrap notes

This branch (`phase-b-fork-bootstrap`) is the merge-of-record between
[`agent0ai/space-agent`](https://github.com/agent0ai/space-agent) `main` and
the [`skybluecycology/benny`](https://github.com/skybluecycology/benny) tree
(via `claude/awesome-williamson-3593d1`, which carries the ADR-001 Phase A
backend prep).

## What landed

| Area              | Source                                                      | Lands at                         |
| ----------------- | ----------------------------------------------------------- | -------------------------------- |
| Browser shell     | space-agent main (`9c26f9f`)                                | `app/`, `server/`, `space/`      |
| Desktop packaging | space-agent main                                            | `packaging/`                     |
| Deterministic substrate | benny `claude/awesome-williamson-3593d1` (`e741043`) | `runtime/` (squashed subtree)    |
| Dev launcher      | this commit                                                 | `scripts/dev.ps1`, `scripts/dev.sh` |
| Top-level README  | this commit                                                 | `README.md`                      |

## Verification

The runtime carries the ADR-001 Phase A surfaces. From the prime-silo root:

```powershell
$env:BENNY_HMAC_KEY = "<your hex key>"
cd runtime
python -m pip install -e .
python -m benny.api.server
```

Then in another terminal:

```powershell
curl http://localhost:8005/api/agent_sandbox/health
# → {"status":"ok","subdirs":["views","notes","drafts","skills"]}

curl http://localhost:8005/api/widgets
# → [{"id":"kg3d.synoptic_web", ...}, ..., {"id":"text.markdown", ...}]
```

The 23 sandbox tests pass under `runtime/`:

```powershell
cd runtime
python -m pytest tests/api/test_agent_sandbox.py -q
# → 23 passed
```

## What is NOT yet wired

Phase B intentionally stops at "two processes side-by-side". The shell does
not yet proxy `/api/*` to the runtime, the agent runtime does not yet send
`X-Benny-Agent-Scope: sandbox`, and the widget components have not been
ported into space-agent's frontend module system. Those are Phases C–D.

## Known follow-ups

1. **Benny push.** The Phase A commit `e741043` lives on `claude/awesome-williamson-3593d1`
   in the local Benny worktree but is not yet pushed to
   `skybluecycology/benny` due to a Git Credential Manager / gh CLI auth
   mismatch. Resolve credentials and push, or convert this fork's `runtime/`
   subtree source to `https://github.com/skybluecycology/benny.git` once
   Phase A is on Benny's master.
2. **Frontend proxy + scope header.** Phase D wiring — adds `app/server`-side
   proxy and the agent runtime's outbound HTTP shim that injects
   `X-Benny-Agent-Scope` per request.
3. **Widget migration.** Phase C — port `KnowledgeGraphCanvas`, the
   parameterised `dag.canvas`, drill-down, frame inspector, lineage timeline
   into `app/L0/widgets/<category>/`.
4. **CI gates.** Mirror Benny's release-gate suite over `runtime/` and add
   the two fork-specific gates (G-AGENT, G-VIEW) per
   [`runtime/docs/operations/FORK_PROCEDURE.md`](runtime/docs/operations/FORK_PROCEDURE.md) §7.

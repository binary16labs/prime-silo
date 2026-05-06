# Prime-Silo Fork Procedure (ADR-001 Phase B)

This document is the operator runbook for forking
[`agent0ai/space-agent`](https://github.com/agent0ai/space-agent) into the
`prime-silo` shell. It is invoked **after** ADR-001 Phase A has merged in
this Benny repo (sandbox boundary, scope guard, widget contract — already in
place on this branch).

> **Heads-up.** Phase B creates a new external GitHub repository. This is a
> hard-to-reverse action that affects shared state (your GitHub account /
> org). Run this procedure only when you have decided on the final repo name
> and visibility.

---

## Prerequisites

| Item                 | Required                                                                              |
| -------------------- | ------------------------------------------------------------------------------------- |
| Repo name decision   | Working name `prime-silo`. Confirm with stakeholders before running.                   |
| GitHub org / owner   | Where the new repo lives.                                                              |
| Visibility           | Public (matches Prime-Silo PRD §17 open-source posture) or private during incubation. |
| `BENNY_HMAC_KEY`     | The fork must inherit the *same* HMAC key so existing `.aamp` packs verify.            |
| `BENNY_HOME`         | Will keep its existing layout — `agent_sandbox/` already provisioned.                  |

## Step 1 — Create the empty fork

```bash
# Replace OWNER with the destination org/user.
gh repo create OWNER/prime-silo \
  --description "Prime-Silo — adaptive shell over the Benny deterministic substrate" \
  --public \
  --clone

cd prime-silo
```

## Step 2 — Pull in the upstream space-agent shell

```bash
git remote add upstream https://github.com/agent0ai/space-agent.git
git fetch upstream
git merge upstream/main --allow-unrelated-histories -m "fork: import space-agent main"
```

If the merge surfaces conflicts (it shouldn't on a freshly created repo),
prefer the upstream version — your customisation lives in `runtime/` and
`frontend/src/widgets/`, not in the upstream tree.

## Step 3 — Vendor the Benny runtime as a subtree

From inside the `prime-silo` checkout:

```bash
git remote add benny https://github.com/skybluecycology/benny.git
git fetch benny
git subtree add --prefix=runtime benny master --squash
```

The Benny tree now lives under `runtime/` inside the fork. Pulling future
Benny updates is one command:

```bash
git subtree pull --prefix=runtime benny master --squash
```

## Step 4 — Wire the Benny backend as the shell's runtime

Inside the fork:

1. Add a `runtime/` boot script that starts `benny up` against the fork's
   `BENNY_HOME` (typically `./.benny_home/` for dev, configurable for prod).
2. Configure space-agent's frontend to proxy `/api/*` to
   `http://localhost:8005` (Benny's default port — see `benny/api/server.py`).
3. Configure the shell's agent runtime to send
   `X-Benny-Agent-Scope: sandbox` on every mutating request.
   The `AgentScopeMiddleware` will reject sandbox-scoped writes outside
   `/api/agent_sandbox/`.

A reference `prime-silo/scripts/dev.sh` worth committing:

```bash
#!/usr/bin/env bash
set -euo pipefail
export BENNY_HOME="${PWD}/.benny_home"
export BENNY_HMAC_KEY="${BENNY_HMAC_KEY:?must be set}"
( cd runtime && python -m benny.api.server ) &
RUNTIME_PID=$!
trap "kill $RUNTIME_PID" EXIT
npm --prefix shell run dev
```

## Step 5 — Migrate the widget registry

The Phase A widget manifests are committed in
[`benny/api/widget_routes.py`](../../benny/api/widget_routes.py) and the
matching TS contract in
[`frontend/src/widgets/contracts.ts`](../../frontend/src/widgets/contracts.ts).
Phase C of the ADR-001 plan moves the actual React components under
`frontend/src/widgets/<category>/` and replaces the stub manifests with real
`props` JSON Schemas. Order of migration (highest value first):

1. `kg3d.synoptic_web` — already a self-contained Three.js component.
2. `dag.canvas` — collapses `ManifestCanvas`, `PipelineCanvas`,
   `WorkflowCanvas` into one parameterised widget. Mode switch via prop.
3. `run.drilldown_table`
4. `run.frame_inspector`
5. `run.lineage_timeline`

Keep both old and new components working side-by-side until the shell-side
consumers migrate. Delete the old paths only after the shell stops importing
them.

## Step 6 — `.aamp.view` signing

Saved layouts are HMAC-signed using `benny.agentamp.signing.sign_skin_pack`'s
canonical-payload approach (the same path that signs skin packs today). A
`view_signing.py` helper in the fork should:

1. Strip `signature` from the JSON document.
2. Canonicalise via `json.dumps(..., sort_keys=True, separators=(",", ":"))`.
3. HMAC-SHA256 with `BENNY_HMAC_KEY`.

Do not invent a new key resolution path — reuse `_get_hmac_key()` so views,
manifests, and skin packs share one root of trust.

## Step 7 — CI / release gates

The fork inherits Benny's release gate suite (G-COV, G-SR1, G-LAT, G-ERR,
G-SIG, G-OFF — see [BENNY_OPERATING_MANUAL](BENNY_OPERATING_MANUAL.md)).
Add two fork-specific gates:

| Gate    | Check                                                                             |
| ------- | --------------------------------------------------------------------------------- |
| G-AGENT | `pytest runtime/tests/test_agent_sandbox.py -q` — sandbox boundary not regressed. |
| G-VIEW  | Every committed `.aamp.view` fixture verifies under the HMAC key.                  |

## Step 8 — Reverse-sync changes back to Benny

Phase A backend changes (sandbox routes, scope middleware, widget registry,
agent authorship lineage) belong in **upstream Benny**, not the fork. Use
`git subtree push` or cherry-pick PRs back to
[`skybluecycology/benny`](https://github.com/skybluecycology/benny). The fork
should only own:

- Space-agent shell customisations
- The widget React components (after migration)
- `.aamp.view` view bundles
- Fork-specific docs

Anything that touches `runtime/benny/` should land upstream first.

## Rollback

The fork is additive. To roll back Phase B without touching the deterministic
substrate, archive the `prime-silo` repo. Benny's `agent_sandbox/` directories
remain in place (empty) and are harmless — the middleware is a no-op for any
request that does not carry `X-Benny-Agent-Scope`.

---

## Quick verification after Phase B

From inside `prime-silo/`:

```bash
# 1. Backend boots
( cd runtime && python -m benny.api.server ) &
sleep 2
curl -fsS http://localhost:8005/api/agent_sandbox/health
curl -fsS http://localhost:8005/api/widgets

# 2. Sandbox boundary holds
curl -fsS -X POST http://localhost:8005/api/files/download-url \
  -H "X-Benny-Agent-Scope: sandbox" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://example.com","workspace":"default"}' \
  -o /tmp/should_be_403 -w "%{http_code}\n"
# Expect: 403

# 3. Sandbox writes succeed
curl -fsS -X POST http://localhost:8005/api/agent_sandbox/write \
  -H "X-Benny-Agent-Scope: sandbox" \
  -H "Content-Type: application/json" \
  -d '{"workspace":"default","subdir":"notes","filename":"hello.md","content":"# hi"}'
# Expect: 200, status="written"
```

If those three calls behave correctly, Phase B is operational.

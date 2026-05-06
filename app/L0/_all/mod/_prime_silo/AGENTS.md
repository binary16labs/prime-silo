# AGENTS — `_prime_silo/`

This module tree owns the **Prime-Silo browser-side surfaces** that wrap the Benny FastAPI runtime mounted at `runtime/` in this fork.

It is the shell-side counterpart to ADR-001 ([`runtime/architecture/ADR-001-prime-silo-shell-fork.md`](../../../../runtime/architecture/ADR-001-prime-silo-shell-fork.md)).

## Sub-modules

| Module                  | Owns                                                                         |
| ----------------------- | ---------------------------------------------------------------------------- |
| `runtime_client/`       | Fetch helper for `/api/runtime/*` calls; injects `X-Benny-Agent-Scope` when invoked from agent context. |
| `widgets/`              | Widget registry client + JSDoc mirror of [`runtime/frontend/src/widgets/contracts.ts`](../../../../runtime/frontend/src/widgets/contracts.ts). Phase C migrates the actual canvas components (KG3D, dag.canvas, drill-down, frame inspector, lineage timeline) into this folder. |

## Boundary

- The shell never *originates* writes that mutate institutional state. Either:
  - The user clicks a deterministic-zone surface → the request flows without a scope header (regular human RBAC).
  - The agent composes a Review-zone layout or pins a draft → the request flows with `X-Benny-Agent-Scope: sandbox` and the runtime's `AgentScopeMiddleware` confines it to `agent_sandbox/`.
- Scope header injection lives in `runtime_client/`; nothing else in this tree should set it directly.

## Phase status

- **Phase D (this module)** — runtime_client + widget registry client are scaffolded; agent-runtime header injection wires through `runtime_client.fetchAsAgent()`.
- **Phase C** — canvas migration. Each widget gets a folder under `widgets/` matching the manifest IDs registered by [`runtime/benny/api/widget_routes.py`](../../../../runtime/benny/api/widget_routes.py).
- **Phase F** — saved-layout signing. `widgets/` will gain a `views/` sub-folder for `.aamp.view` bundle helpers using the existing skin-pack HMAC path.

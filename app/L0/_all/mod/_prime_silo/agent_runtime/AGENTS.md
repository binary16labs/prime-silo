# AGENTS — `_prime_silo/agent_runtime/`

## Purpose

Phase D2 chokepoint for **agent → Benny runtime** calls. When the
space-agent browser-resident agent runs a turn, it mounts an agent
context here; from then on every `/api/runtime/*` hop made by tools,
skills, or widgets it spawns carries the `X-Benny-Agent-Scope` header
and is audited by Benny's `AgentScopeMiddleware`.

## Files

| File                    | Owns                                                                          |
| ----------------------- | ----------------------------------------------------------------------------- |
| `agent-runtime.js`      | `mountAgentTurn(scope)`, `runWithAgentContext(scope, fn)`, `getCurrentAgentScope()`. |

The actual transport — `createAgentRuntimeClient`, `withAgentScope`,
`fetchAsAgent` — lives in [`../runtime_client/runtime-client.js`](../runtime_client/runtime-client.js).
This module is the **named import** the agent runtime reaches for so the
boundary is auditable: grep for `agent-runtime.js` to find every place an
agent call surface is constructed.

## Two integration patterns

### `mountAgentTurn(scope)` — the long-running pattern (preferred)

For agent turns that span multiple awaits, tool invocations, or widget
mounts. Browsers don't have `AsyncLocalStorage`, so a turn-scoped global
would lose context across `await` boundaries. The bound runtime client
solves that by capturing the scope in a closure, not in module-level
state.

```js
import { mountAgentTurn } from "/mod/_prime_silo/agent_runtime/agent-runtime.js";
import { createReasoningTraceWidget } from "/mod/_prime_silo/widgets/run/reasoning_trace/index.js";

const turn = mountAgentTurn("sandbox");
try {
  // Hand the bound runtimeClient to whatever the agent spawns. Widgets
  // and skills already accept options.runtimeClient — no per-call wiring.
  createReasoningTraceWidget(host, props, { runtimeClient: turn.runtimeClient });
} finally {
  turn.dispose();
}
```

The handle's `dispose()` is a no-op today; reserved for future telemetry
(turn-level lineage events, audit-trail close markers).

### `runWithAgentContext(scope, fn)` — the synchronous-flow pattern

Narrow alternative for *short, synchronous* call sites where the agent
just needs the next `runtimeFetch` to carry a scope. Implemented via the
module-level active-scope variable in `runtime-client.js`. The unbound
`runtimeFetch` consults this variable and auto-injects the header when
the call site didn't already set one.

```js
import { runWithAgentContext } from "/mod/_prime_silo/agent_runtime/agent-runtime.js";
import { runtimeFetch } from "/mod/_prime_silo/runtime_client/runtime-client.js";

await runWithAgentContext("read_only", () => runtimeFetch("/widgets"));
```

Once `fn` resolves, the ambient scope is restored. Don't use this for
long-running loops — the await chain inside the callback can leak across
microtasks, and you'll lose the scope by the second `runtimeFetch` if it
sits behind an unrelated `await`. **Long loops belong in `mountAgentTurn`.**

## Why two routes?

The bound client is the right abstraction for the agent's own call
surface — it's explicit, composable, threadable through deep call
graphs. The synchronous helper is the right abstraction for retrofitting
existing code paths that already grab the unbound `runtimeFetch` and
just need a scope on this one call without rewriting the whole module.

Both routes hit the same `AgentScopeMiddleware` in Benny. The boundary
is policy-enforced (the runtime returns 403 for an agent write outside
`agent_sandbox/`), not convention-enforced — these helpers are about
**audit-trail completeness**, not about gating writes.

## Defence-in-depth

The shell does not synthesise scope headers. The browser-side agent is
the source of truth for "is this call an agent action?". The proxy
strips, forwards, and stays out of the policy decision. Two facts make
this safe:

1. The proxy injects `X-Benny-API-Key` (the governance key) but
   **passes through** `X-Benny-Agent-Scope` unchanged. The shell can't
   weaken or escalate the scope.
2. The runtime's middleware is the only enforcer. If a future shell
   change accidentally drops the header, the worst case is a 403 from
   the runtime — not silent privilege escalation.

That makes Phase D2's job tightly bounded: ensure the header is set
correctly at the right call sites. The runtime client + this module
make that one change in one place.

## Authority

This module is itself unauthenticated browser code — anyone who can
load the shell can invoke `mountAgentTurn`. The middleware is the
gate. Keep it that way: never centralise the scope decision here in a
way that hides it from the runtime audit log.

# SPEC — Coordination ledger (B0)

> One honest ledger many agents can share. Normative for Workstream B (B1 API/SSE, B2 CLI/MCP,
> B3 Bridge panel) and for W0 work-contract state derivation.
> Schemas: `server/coordination/schema/` · Reference impl: `server/coordination/lib/ledger.mjs`
> Tests: `tests/coordination/` · Gate: `node scripts/gates/b0.mjs`

## Location

`PRIME_SILO_HOME/coordination/` (home resolution per HOME-DIRECTORY.md / `/api/home`):

```
coordination/
├── tasks.jsonl        # append-only event log — THE truth
├── agents.json        # { "agents": [...] } registry; seed: claude, antigravity, opencode, benny, human
├── leases/<task_id>.json   # advisory claim locks (wx-created)
└── knowledge/*.md     # shared notes, one fact per file
```

## Events (`event.schema.json`)

One JSON object per line. Types: `task_created`, `task_claimed`, `task_progress`, `task_done`,
`task_blocked`, `task_released`, `knowledge_added`.

Fields: `id` (ULID), `ts` (ISO-8601 with timezone), `type`, `agent` (must be registered in
`agents.json` — extensible registry, deliberately not a schema enum), `task_id` (`"-"` for
knowledge events not tied to a task), `payload` (object), optional `run_id` (links the task to a
G0 run stream `runs/<run_id>/events.jsonl`), and `prev` (chain hash, below). Unknown fields are
rejected. A malformed event is rejected with a reason and **nothing is appended**.

## Append-only + tamper evidence

Agents never edit or delete ledger lines. Each appended line carries
`prev = sha256(previous raw line)[0..16]` (`"genesis"` for the first line), computed by the
appender — callers never set it. Readers re-derive the chain; an edited historical line breaks the
hash of its successor and is reported by 1-based line number. Known limit: an edit to the _last_
line has no successor to betray it — B1 anchors the head hash server-side. Direct-file appends are
serialized by a `tasks.jsonl.lock` `wx` lockfile (stale after 10 s); when the B1 server is up it is
the single appender. Compaction is a human-run CLI, out of scope.

## State = fold(events)

Task state is derived **solely** by folding `tasks.jsonl` in order — the ledger is truth, leases
are advisory locks:

| event                        | resulting state                     |
| ---------------------------- | ----------------------------------- |
| task_created                 | todo                                |
| task_claimed / task_progress | claimed (by `agent`)                |
| task_done                    | done                                |
| task_blocked                 | blocked (`payload.reason` surfaced) |
| task_released                | todo (agent cleared)                |
| knowledge_added              | no task-state change                |

## Claim protocol (collision safety)

To work task T, an agent creates `leases/T.json` (`lease.schema.json`: `task_id`, `agent`,
`claimed_at`, `expires_at = now + 15 min`) with the **atomic create-exclusive `wx` flag** — the
filesystem picks exactly one winner. The winner appends `task_claimed` (`payload.takeover` flags
lease takeovers); losers get `already-claimed` and walk away.

- **Heartbeat:** the owner renews `expires_at` (never shortening it) at least every 15 min.
- **Expiry:** a lease whose `expires_at` is past is claimable by anyone: unlink the stale file,
  then race `wx` create again — still exactly one winner.
- **Release:** owner unlinks the lease and appends `task_released`.

## Knowledge notes (`knowledge.schema.json`)

One fact per markdown file under `knowledge/`, YAML frontmatter: `topic`, `source_agent`
(registered id), `confidence` (`low|medium|high`). Announced on the ledger via `knowledge_added`
with `payload.file`.

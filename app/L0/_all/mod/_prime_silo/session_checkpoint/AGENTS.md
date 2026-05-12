# session_checkpoint — AGENTS.md

**Module:** `app/L0/_all/mod/_prime_silo/session_checkpoint/`
**Phase:** H (H1 shipped; H2 = fork+UI; H3 = pin+HMAC)
**ADR reference:** ADR-001 Phase H — Session Checkpoints

---

## Purpose

This module gives the in-browser agent and the operator a way to save named snapshots of a session (conversation history + loaded skills + transient context + run references), restore to any of those snapshots, and fork off isolated branches for speculative analysis.

---

## File structure

| File | Role |
|------|------|
| `index.js` | Public API — re-exports all user-facing functions |
| `checkpoint-client.js` | Fetch helpers — one function per runtime endpoint |
| `checkpoint-restore.js` | Restore + fork helpers (`applyCheckpointRestore`, `buildForkName`, …) |
| `checkpoint-compact.js` | Pre-save history size guard; H2 will add LLM compaction |
| `AGENTS.md` | This file |

---

## Key functions (import from `index.js`)

```js
// H1 — draft operations
saveCheckpoint(scope, workspace, name, sessionState, options?)
loadCheckpoint(scope, workspace, name)
listCheckpoints(scope, workspace, options?)
deleteCheckpoint(scope, workspace, name, options?)

// H2 — fork (API ready, UI chrome in H2)
forkCheckpoint(scope, workspace, name)

// H3 — pin (API ready, UI chrome in H3)
pinCheckpoint(workspace, name, options?)
loadPinnedCheckpoint(workspace, name)

// Restore helpers (re-exported from checkpoint-restore.js)
applyCheckpointRestore(checkpoint, options?)
buildForkName(baseName, existingCheckpoints)
buildPreRestoreName()
buildRestoreNotice(checkpointName)

// Compaction guard (re-exported from checkpoint-compact.js)
compactHistoryForCheckpoint(history, settings?)
```

---

## Scope model

| Function | Scope required | Why |
|----------|---------------|-----|
| `saveCheckpoint` | `sandbox` | Writes to `agent_sandbox/checkpoints/` |
| `loadCheckpoint` | none (read) | Reads are unrestricted |
| `listCheckpoints` | none for drafts | `scope` passed but read-only |
| `deleteCheckpoint` | `sandbox` | Deletes from `agent_sandbox/checkpoints/` |
| `forkCheckpoint` | `sandbox` | Reads + saves a new draft |
| `pinCheckpoint` | none (human-only) | Sends no scope header; runtime 403s agent callers |
| `loadPinnedCheckpoint` | none (read) | Reads are unrestricted |

---

## Security rules

- The agent **cannot** overwrite a pinned checkpoint (pinned lives outside `/api/agent_sandbox/`).
- The agent **can** overwrite its own earlier un-pinned drafts (same name → overwrite).
- `forkCheckpoint` strips the `signature` field — forks are always `draft` until a human pins.
- Path traversal in checkpoint names is rejected by the runtime (`[a-zA-Z0-9_-]`, max 80 chars).

---

## Checkpoint schema

```jsonc
{
  "schema": "aamp.checkpoint/1",
  "name": "after-data-load",
  "workspace": "c5_test",
  "saved_at": "2026-05-12T14:30:00Z",
  "history": [{ "role": "user", "content": "..." }],
  "skills": ["browser-control", "data-analyst"],
  "transient_items": {
    "file:q3_sales": { "path": "~/data/q3_sales.csv", "encoding": "utf8" }
  },
  "run_refs": ["run-abc123"],
  "manifest_refs": [],
  "metadata": {
    "description": "Q3 data loaded",
    "source": "operator",
    "fork_of": null,
    "fork_index": null,
    "pre_restore_of": null
  }
}
```

---

## Phase breakdown

### H1 (shipped)
- `checkpoint-client.js` — 7 fetch helpers
- `checkpoint-restore.js` — `applyCheckpointRestore`, `buildForkName`, `buildPreRestoreName`, `buildRestoreNotice`
- `checkpoint-compact.js` — size guard (LLM compaction in H2)
- `index.js` — public API
- Runtime: `checkpoint_routes.py` (4 draft + 3 pinned endpoints)
- Tests: `tests/session_checkpoint_test.mjs`, `runtime/tests/api/test_checkpoint_routes.py`

### H2 (next)
- Chat panel save button + checkpoint picker dropdown
- Fork badge (persistent "Working in: <fork>" label with "back to base" link)
- Runs Explorer HITL banner (auto-offer checkpoint before human-review interaction)
- Auto-save `pre-restore-<ts>` before every restore
- CLI: `benny checkpoint save|list|inspect|delete|fork|template`

### H3 (after H2)
- `pinCheckpoint` / `loadPinnedCheckpoint` UI integration in the checkpoint picker
- `CHECKPOINT_PINNED` audit event (already emitted by the runtime in H1)
- CLI: `benny checkpoint pin` + `inspect` reporting `pinned (valid ✓)`

---

*Prime-Silo — engineered by Binary 16.*

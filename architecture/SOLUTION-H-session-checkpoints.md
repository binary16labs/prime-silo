# Solution Design — Phase H: Session Checkpoints

**Status:** draft  
**Phase:** H (H1 → H2 → H3)  
**Author:** Binary 16  
**Date:** 2026-05-12  
**Companion:** [`REQUIREMENTS-H-session-checkpoints.md`](REQUIREMENTS-H-session-checkpoints.md)

---

## 1. Overview

Session checkpoints extend the existing `agent_sandbox/` write pattern (Phase D3) with a dedicated `checkpoints/` subdir and three new runtime endpoints. The browser side adds a `session_checkpoint/` module inside `_prime_silo/` that wraps those endpoints with the same scope-chokepoint model used by `runtime_client/`. Pinning (Phase H3) reuses the Phase F2 signing pipeline without modification.

The implementation deliberately reuses every existing convention:

| Existing pattern | Reused by |
|---|---|
| `agent_sandbox/views/` path helpers | `agent_sandbox/checkpoints/` path helpers |
| `saveView` / `loadView` / `listViews` browser helpers | `saveCheckpoint` / `loadCheckpoint` / `listCheckpoints` |
| `pinView` HMAC signing pipeline | `pinCheckpoint` (H3) |
| `loadPinnedView` integrity check | `loadPinnedCheckpoint` (H3) |
| `AgentScopeMiddleware` | unchanged — checkpoints ride the same middleware |
| History compaction (`compact-prompt-auto.md`) | triggered when history exceeds the 2 MB cap |

---

## 2. Checkpoint file schema

File: `agent_sandbox/checkpoints/<name>.json`  
Pinned file: `workspaces/<ws>/checkpoints/<name>.json`

```jsonc
{
  "schema": "aamp.checkpoint/1",
  "name": "after-data-load",
  "workspace": "c5_test",
  "saved_at": "2026-05-12T14:30:00Z",

  // The full conversation up to the save point.
  // Automatically compacted (compact-prompt-auto.md) when serialised
  // size exceeds 2 MB; the first message in that case is the compact summary.
  "history": [
    { "role": "system",    "content": "..." },
    { "role": "user",      "content": "load the Q3 sales data" },
    { "role": "assistant", "content": "Loading ~/data/q3_sales.csv now...\n_____javascript\n..." }
  ],

  // Skill IDs to re-invoke via space.skills.load() on restore.
  "skills": ["browser-control", "data-analyst"],

  // Transient context items to re-stage in the prompt budget on restore.
  // Values are path references, NOT copied file contents (NG5).
  "transient_items": {
    "file:q3_sales": { "path": "~/data/q3_sales.csv", "encoding": "utf8" }
  },

  // Run and manifest IDs the checkpoint was created against.
  // Used by the Runs Explorer / Manifest Explorer to auto-select on restore.
  "run_refs": ["run-abc123"],
  "manifest_refs": ["mf-q3-sales"],

  "metadata": {
    "description": "Q3 data loaded, ready for analysis",
    "source": "operator",          // "operator" | "agent" | "template"
    "fork_of": null,               // parent checkpoint name if this is a fork
    "fork_index": null,            // integer — 1-based fork number
    "pre_restore_of": null         // set when auto-saved before a restore
  },

  // Present only in PINNED checkpoints (Phase H3).
  // Stripped before HMAC computation, same as .aamp.view.
  "signature": {
    "algorithm": "HMAC-SHA256",
    "value": "a1b2c3...",
    "signed_at": "2026-05-12T15:00:00Z"
  }
}
```

**Schema versioning:** `aamp.checkpoint/1` is the initial version. Breaking changes bump the minor version; the load path rejects unknown major versions.

---

## 3. Filesystem layout

```
$BENNY_HOME/workspaces/<ws>/
├── agent_sandbox/
│   ├── views/                ← Phase D3  (mutable draft layouts)
│   └── checkpoints/          ← Phase H1  (mutable session snapshots)  NEW
│       ├── after-data-load.json
│       ├── pre-hitl-run-abc123.json
│       └── analysis-base_fork_1.json
│
└── checkpoints/              ← Phase H3  (pinned, HMAC-signed)  NEW
    └── analysis-base.json
```

The split mirrors `views/` (draft) vs `workspaces/<ws>/views/` (pinned).

---

## 4. Runtime (backend)

### 4.1 New file

`runtime/benny/api/checkpoint_routes.py`

All endpoints mount under `/api/agent_sandbox/checkpoints/` (draft operations, sandbox-scoped) or `/api/checkpoints/` (pin/load operations, human-scoped, outside the sandbox prefix).

### 4.2 Draft endpoints (sandbox-scoped, all behind AgentScopeMiddleware)

```python
POST   /api/agent_sandbox/checkpoints/save
GET    /api/agent_sandbox/checkpoints/list/<ws>
GET    /api/agent_sandbox/checkpoints/load/<ws>/<name>
DELETE /api/agent_sandbox/checkpoints/delete/<ws>/<name>
```

**`POST /api/agent_sandbox/checkpoints/save`**

Request body:

```json
{
  "workspace": "c5_test",
  "name": "after-data-load",
  "checkpoint": { /* full aamp.checkpoint/1 object */ }
}
```

Validation:
- `name` must be a single path component (no `/`, no `..`, no leading dot, `[a-zA-Z0-9_-]` only, max 80 chars).
- `checkpoint.schema` must equal `"aamp.checkpoint/1"`.
- `checkpoint.history` is validated as an array of `{role, content}` — roles limited to `system`, `user`, `assistant`.
- Total serialised size checked against 2 MB cap. If exceeded, the server returns HTTP 413 with `{"detail": "history_too_large", "bytes": N, "max_bytes": 2097152}`. The browser side must compact before retrying.
- Path traversal: resolved path must be a child of `$BENNY_HOME/workspaces/<ws>/agent_sandbox/checkpoints/`.

Response: `{"saved": true, "path": "agent_sandbox/checkpoints/after-data-load.json", "bytes": N}`

**`GET /api/agent_sandbox/checkpoints/list/<ws>`**

Returns an array of checkpoint summaries (no history body — metadata only):

```json
[
  {
    "name": "after-data-load",
    "saved_at": "2026-05-12T14:30:00Z",
    "status": "draft",
    "skill_count": 2,
    "message_count": 18,
    "run_refs": ["run-abc123"],
    "manifest_refs": [],
    "source": "operator",
    "fork_of": null,
    "description": "Q3 data loaded"
  }
]
```

**`GET /api/agent_sandbox/checkpoints/load/<ws>/<name>`**

Returns the full checkpoint body.

**`DELETE /api/agent_sandbox/checkpoints/delete/<ws>/<name>`**

Deletes the draft file. Returns 404 if not found. Returns 409 if the checkpoint name also exists in the pinned dir (`workspaces/<ws>/checkpoints/`) — the draft can be deleted but the pinned copy is unchanged.

### 4.3 Pin/load endpoints (human-scoped, outside `/api/agent_sandbox/`)

```python
POST   /api/checkpoints/pin
GET    /api/checkpoints/list/<ws>
GET    /api/checkpoints/load/<ws>/<name>
```

These are mounted at the same level as `/api/views/pin` and `/api/views/load` (Phase F2). `AgentScopeMiddleware` 403s any scoped call to `POST /api/checkpoints/pin` identically to `POST /api/views/pin`.

**`POST /api/checkpoints/pin`**

Request body:
```json
{
  "workspace": "c5_test",
  "source_name": "analysis-base",
  "pinned_by": "operator@binary16",
  "target_name": "analysis-base"    // optional — defaults to source_name
}
```

Server behaviour (mirrors Phase F2 `pinView` exactly):
1. Validate names.
2. Read `agent_sandbox/checkpoints/<source_name>.json`, parse as JSON.
3. Strip `signature` field if present.
4. HMAC-SHA256 over canonical payload (sorted keys, no whitespace).
5. Embed `signature` inline.
6. Write to `workspaces/<ws>/checkpoints/<target_name>.json`.
7. Emit `CHECKPOINT_PINNED` audit event.

Response: `{ "pinned_path": "...", "bytes_written": N, "signature": {...} }`

**`GET /api/checkpoints/load/<ws>/<name>`**

Mirrors `GET /api/views/load/<ws>/<filename>` (Phase F2b):
- Reads the pinned file.
- Extracts `signature`, strips it, recomputes HMAC, returns `valid` bool.
- Returns `{ checkpoint, signature, valid }`.
- Missing/malformed signature → `valid: false`, HTTP 200 (not an error, caller decides).

**`GET /api/checkpoints/list/<ws>`**

Lists pinned checkpoints only (from `workspaces/<ws>/checkpoints/`). Returns the same summary shape as the draft list endpoint, with `status: "pinned"` and a `valid` boolean for each.

### 4.4 Path helpers

Add to `runtime/benny/api/path_helpers.py` (or equivalent):

```python
def get_checkpoint_draft_dir(workspace: str) -> Path:
    return get_agent_sandbox_dir(workspace) / "checkpoints"

def get_checkpoint_pinned_dir(workspace: str) -> Path:
    return get_workspace_dir(workspace) / "checkpoints"

def resolve_checkpoint_draft_path(workspace: str, name: str) -> Path:
    return _resolve_safe_child(get_checkpoint_draft_dir(workspace), name + ".json")

def resolve_checkpoint_pinned_path(workspace: str, name: str) -> Path:
    return _resolve_safe_child(get_checkpoint_pinned_dir(workspace), name + ".json")
```

### 4.5 Registration

In `runtime/benny/api/server.py`, register the new router:

```python
from .checkpoint_routes import router as checkpoint_router
app.include_router(checkpoint_router)
```

---

## 5. Browser (frontend)

### 5.1 New module

`app/L0/_all/mod/_prime_silo/session_checkpoint/`

```
session_checkpoint/
├── index.js          ← public API (all exports)
├── checkpoint-client.js   ← fetch helpers (mirrors runtime_client.js pattern)
├── checkpoint-restore.js  ← restore + fork + skill re-load logic
├── checkpoint-compact.js  ← history compaction before save (uses compact-prompt-auto.md)
└── AGENTS.md
```

### 5.2 Public API — `index.js`

```js
// Save the current session state as a named checkpoint.
export async function saveCheckpoint(scope, workspace, name, sessionState, options = {});

// Restore a checkpoint — returns the full checkpoint object for the caller to apply.
export async function loadCheckpoint(scope, workspace, name);

// List checkpoints (drafts or pinned) in a workspace.
export async function listCheckpoints(scope, workspace, options = { pinned: false });

// Delete a draft checkpoint.
export async function deleteCheckpoint(scope, workspace, name);

// Fork: create a numbered branch. Returns the fork name.
export async function forkCheckpoint(scope, workspace, name);

// Pin a draft (human-only, no scope header).
export async function pinCheckpoint(workspace, name, options = {});

// Load a pinned checkpoint + verify HMAC. Returns { checkpoint, signature, valid }.
export async function loadPinnedCheckpoint(workspace, name);
```

All scoped functions (`saveCheckpoint`, `loadCheckpoint`, etc.) use `createAgentRuntimeClient(scope)` internally — same transport as `saveView` / `loadView`. `pinCheckpoint` and `loadPinnedCheckpoint` use bare `runtimeFetch` (no scope header), same as `pinView`.

### 5.3 `checkpoint-client.js` — fetch helpers

```js
import { createAgentRuntimeClient, runtimeFetch } from "../runtime_client/runtime-client.js";

export async function fetchSaveCheckpoint(scope, workspace, name, checkpoint) {
  const client = createAgentRuntimeClient(scope);
  return client.post("/agent_sandbox/checkpoints/save", { workspace, name, checkpoint });
}

export async function fetchListCheckpoints(scope, workspace) {
  const client = createAgentRuntimeClient(scope);
  return client.get(`/agent_sandbox/checkpoints/list/${workspace}`);
}

export async function fetchLoadCheckpoint(scope, workspace, name) {
  const client = createAgentRuntimeClient(scope);
  return client.get(`/agent_sandbox/checkpoints/load/${workspace}/${name}`);
}

export async function fetchDeleteCheckpoint(scope, workspace, name) {
  const client = createAgentRuntimeClient(scope);
  return client.delete(`/agent_sandbox/checkpoints/delete/${workspace}/${name}`);
}

export async function fetchPinCheckpoint(workspace, name, pinnedBy, targetName) {
  return runtimeFetch("/checkpoints/pin", {
    method: "POST",
    body: JSON.stringify({ workspace, source_name: name, pinned_by: pinnedBy, target_name: targetName })
  });
}

export async function fetchLoadPinnedCheckpoint(workspace, name) {
  return runtimeFetch(`/checkpoints/load/${workspace}/${name}`);
}
```

### 5.4 `checkpoint-restore.js` — restore logic

The restore path does three things in order:

1. **Replace history** — the calling component swaps its `historyMessages` array with `checkpoint.history`.
2. **Re-load skills** — for each `id` in `checkpoint.skills`, call `space.skills.load(id)`. Errors are collected but do not abort the restore (surfaced as warnings).
3. **Re-stage transient items** — for each entry in `checkpoint.transient_items`, re-read the referenced path and re-add to the prompt's transient context.

```js
export async function applyCheckpointRestore(checkpoint, options = {}) {
  const warnings = [];

  // 1. History — returned to caller for state update
  const restoredHistory = Array.isArray(checkpoint.history) ? checkpoint.history : [];

  // 2. Skills
  const loadedSkills = [];
  for (const skillId of (checkpoint.skills ?? [])) {
    try {
      await space.skills.load(skillId);
      loadedSkills.push(skillId);
    } catch (err) {
      warnings.push({ skill: skillId, error: err.message });
    }
  }

  // 3. Transient items — re-read file paths into context
  const restoredTransient = {};
  for (const [key, item] of Object.entries(checkpoint.transient_items ?? {})) {
    try {
      const content = await space.api.fileRead(item.path, item.encoding ?? "utf8");
      restoredTransient[key] = { ...item, content };
    } catch (err) {
      warnings.push({ transient: key, error: err.message });
    }
  }

  return { restoredHistory, loadedSkills, restoredTransient, warnings };
}
```

### 5.5 `checkpoint-compact.js` — pre-save compaction

Before serialising `history` for save, check the estimated byte size. If over the 2 MB cap, use the existing `fetchDefaultOnscreenAgentHistoryCompactPrompt` mechanism to summarise:

```js
import { fetchHistoryCompactPrompt } from "../../../_core/onscreen_agent/llm.js";

const MAX_CHECKPOINT_BYTES = 2 * 1024 * 1024;

export async function compactHistoryForCheckpoint(history, settings) {
  const serialised = JSON.stringify(history);
  if (serialised.length <= MAX_CHECKPOINT_BYTES) return history;

  // Use auto-compact prompt to collapse history into a single summary message
  const compactPrompt = await fetchHistoryCompactPrompt({ mode: "automatic" });
  const summary = await callCompactionLlm(history, compactPrompt, settings);

  return [
    { role: "user", content: `Conversation summary:\n${summary}` },
    { role: "assistant", content: "Understood. Continuing from this summary." }
  ];
}
```

If compaction itself fails, `saveCheckpoint` surfaces an error: `"Session is too large to checkpoint. Try compacting your conversation history first."` rather than silently truncating.

### 5.6 `saveCheckpoint` full flow

```js
export async function saveCheckpoint(scope, workspace, name, sessionState, options = {}) {
  const { history, skills, transientItems, runRefs, manifestRefs, metadata } = sessionState;

  // 1. Compact if needed
  const compactedHistory = await compactHistoryForCheckpoint(history, options.settings);

  // 2. Build the checkpoint object
  const checkpoint = {
    schema: "aamp.checkpoint/1",
    name,
    workspace,
    saved_at: new Date().toISOString(),
    history: compactedHistory,
    skills: skills ?? [],
    transient_items: transientItems ?? {},
    run_refs: runRefs ?? [],
    manifest_refs: manifestRefs ?? [],
    metadata: {
      description: metadata?.description ?? "",
      source: metadata?.source ?? "operator",
      fork_of: metadata?.forkOf ?? null,
      fork_index: metadata?.forkIndex ?? null,
      pre_restore_of: metadata?.preRestoreOf ?? null
    }
  };

  // 3. Save via runtime client
  return fetchSaveCheckpoint(scope, workspace, name, checkpoint);
}
```

### 5.7 `forkCheckpoint` flow

```js
export async function forkCheckpoint(scope, workspace, name) {
  // Load original
  const original = await fetchLoadCheckpoint(scope, workspace, name);

  // Find next fork index
  const all = await fetchListCheckpoints(scope, workspace);
  const forkPrefix = `${name}_fork_`;
  const existing = all.filter(c => c.name.startsWith(forkPrefix));
  const maxIndex = existing.reduce((m, c) => {
    const n = parseInt(c.name.slice(forkPrefix.length), 10);
    return Number.isFinite(n) ? Math.max(m, n) : m;
  }, 0);
  const forkName = `${forkPrefix}${maxIndex + 1}`;

  // Save fork
  const fork = {
    ...original,
    name: forkName,
    saved_at: new Date().toISOString(),
    metadata: {
      ...original.metadata,
      source: original.metadata?.source ?? "operator",
      fork_of: name,
      fork_index: maxIndex + 1
    }
  };
  delete fork.signature; // forks are never pinned

  await fetchSaveCheckpoint(scope, workspace, forkName, fork);
  return forkName;
}
```

---

## 6. UI integration

### 6.1 Chat panel header — checkpoint controls

Two new controls appear in the chat panel header (right side, beside the gear icon):

```
[💾 Save checkpoint]   [📂 ▾]   ← dropdown opens checkpoint picker
```

**Save checkpoint button:**
- Click → inline name field appears, pre-filled with `checkpoint-<YYYY-MM-DD-HHmm>`.
- Enter / confirm → calls `saveCheckpoint` with current session state.
- Toast on success: `"Saved: checkpoint-2026-05-12-1430"`

**Checkpoint picker dropdown:**
- Lists all checkpoints for the active workspace (drafts + pinned, sorted newest first).
- Pinned checkpoints show a lock icon.
- Forked checkpoints are indented under their parent.
- Actions per entry: Restore | Fork | Pin (if not pinned) | Delete.
- Restore shows a confirm dialog: `"Restoring will replace the current session. A backup will be saved as pre-restore-<timestamp>."`

### 6.2 Runs Explorer integration

When the active run has `status === "paused_for_review"`:

```
┌───────────────────────────────────────────────────────────────────┐
│  ⏸  Run paused — awaiting human review                            │
│  Save a checkpoint before you interact with this run?             │
│  [Save pre-HITL checkpoint]  [Dismiss]                            │
└───────────────────────────────────────────────────────────────────┘
```

Clicking "Save pre-HITL checkpoint" calls `saveCheckpoint` with `name = "pre-hitl-<run_id>"`, `runRefs = [run_id]`, and `source = "operator"`.

### 6.3 Manifest Explorer integration

When the operator selects a manifest from the dropdown:

- No intrusive prompt (manifests are static; no HITL context).
- The active manifest ID is included in `manifest_refs` when the operator manually triggers a checkpoint save from the chat panel while on this page.

### 6.4 Fork badge

When the active session was loaded from a fork, the chat panel header shows a non-intrusive badge:

```
Working in:  analysis-base_fork_1  [back to base]
```

"Back to base" is a single-click restore of the original (non-fork) checkpoint. The user sees the confirm dialog first.

---

## 7. CLI commands

All checkpoint commands live under `benny checkpoint` and run from anywhere (no `cd runtime` needed). They call the runtime API directly.

```
benny checkpoint save <name>   --workspace W [--description "..."] [--run <run_id>] [--manifest <manifest_id>]
benny checkpoint list          --workspace W [--pinned] [--json]
benny checkpoint load <name>   --workspace W [--output-file path.json]
benny checkpoint inspect <name> --workspace W [--verbose]
benny checkpoint delete <name> --workspace W [--force]
benny checkpoint fork <name>   --workspace W
benny checkpoint pin <name>    --workspace W [--target <target_name>]
benny checkpoint template create <name> --workspace W [--skills s1,s2] [--runs r1,r2] [--description "..."]
```

**`benny checkpoint save`** from the CLI creates a checkpoint with **empty history** (the CLI has no interactive session). It is useful for creating templates or anchored starting points with `--run` and `--skills`.

**`benny checkpoint inspect`** output (plain text, default):

```
Checkpoint: analysis-base
Saved:      2026-05-11 09:00:00  (operator)
Status:     pinned (valid ✓)
Skills:     browser-control, data-analyst
Messages:   8  (user: 4, assistant: 3, system: 1)
Runs:       —
Manifests:  mf-q3-sales
Fork of:    —
Description: "Q3 data loaded, baseline established"
```

With `--verbose`, each message in `history` is printed as a collapsed one-liner:
```
  [system]    → "environment\nyou are a browser runtime operator..."  (truncated)
  [user]      → "load the Q3 sales data"
  [assistant] → "Loading ~/data/q3_sales.csv now..."
  ...
```

---

## 8. Security model (boundary compliance)

| Operation | Endpoint prefix | Scope required | Who can call |
|---|---|---|---|
| save (draft) | `/api/agent_sandbox/checkpoints/save` | `sandbox` | Agent or human (with scope header) |
| list drafts | `/api/agent_sandbox/checkpoints/list/<ws>` | `sandbox` | Agent or human |
| load draft | `/api/agent_sandbox/checkpoints/load/<ws>/<name>` | unblocked (read) | Any authenticated caller |
| delete draft | `/api/agent_sandbox/checkpoints/delete/<ws>/<name>` | `sandbox` | Agent or human |
| pin | `/api/checkpoints/pin` | none (human-only) | Human only — scoped callers get 403 |
| list pinned | `/api/checkpoints/list/<ws>` | unblocked (read) | Any authenticated caller |
| load pinned | `/api/checkpoints/load/<ws>/<name>` | unblocked (read) | Any authenticated caller |

The middleware rules are identical to the Phase D3/F2 view pattern. No new middleware logic is needed — checkpoints inherit it automatically by virtue of their URL prefixes.

---

## 9. Phase breakdown

### Phase H1 — save / load / list (draft only)

**Runtime:** `checkpoint_routes.py` with save, list, load, delete endpoints. Path helpers. Server registration.

**Browser:** `session_checkpoint/` module with `saveCheckpoint`, `loadCheckpoint`, `listCheckpoints`, `deleteCheckpoint`, `compactHistoryForCheckpoint`.

**No UI chrome.** API-only. The agent can call `saveCheckpoint` in a turn. The operator can call from the browser console to verify.

**Tests:**
- `tests/session_checkpoint_test.mjs` — unit tests for compaction, schema validation, fork-name generation, restore logic.
- `runtime/tests/api/test_checkpoint_routes.py` — save/list/load/delete endpoint tests including path traversal rejection, 413 response for oversized history, agent scope enforcement.

**Deliverables:** `checkpoint_routes.py`, `session_checkpoint/index.js`, `session_checkpoint/checkpoint-client.js`, `session_checkpoint/checkpoint-restore.js`, `session_checkpoint/checkpoint-compact.js`, `session_checkpoint/AGENTS.md`, tests, ROADMAP update.

---

### Phase H2 — fork + UI chrome

**Browser:** `forkCheckpoint` in `index.js`.

**UI:** Save checkpoint button and checkpoint picker dropdown in the chat panel header. Fork badge when operating inside a fork. Runs Explorer HITL banner. Auto-save-before-restore (`pre-restore-<timestamp>`).

**CLI:** All `benny checkpoint` commands (save, list, inspect, delete, fork, template create).

**Tests:** UI integration tests for the chat panel controls (browser component harness). CLI command tests.

**Deliverables:** All H1 files updated. UI components in the chat panel module. CLI command registration in `benny_cli.py` + handler module. Tests. ROADMAP + OPERATING_MANUAL update.

---

### Phase H3 — pin / load pinned (HMAC-signed, tamper-evident)

**Runtime:** `POST /api/checkpoints/pin` and `GET /api/checkpoints/load/<ws>/<name>` endpoints. Reuse `views_signing.py` HMAC logic. `CHECKPOINT_PINNED` audit event.

**Browser:** `pinCheckpoint` and `loadPinnedCheckpoint` in `index.js`. "Pin" action in UI picker. `valid: false` handling (surface tamper notice).

**CLI:** `benny checkpoint pin`, `benny checkpoint inspect` reporting `pinned (valid ✓)` or `pinned (invalid ✗)`.

**Tests:** `runtime/tests/api/test_checkpoint_pin.py` — mirrors `test_views_signing.py` structure. Browser helper tests for pin and loadPinned.

**Deliverables:** All prior files updated. Signing endpoint. CLI pin command. Tests. ROADMAP + GUIDE.md + OPERATING_MANUAL updates.

---

## 10. Test plan

### Unit tests (browser-side, `.mjs`)

| Test file | What it covers |
|---|---|
| `session_checkpoint_test.mjs` | `compactHistoryForCheckpoint` (size thresholds, compaction trigger, fail-safe), `forkCheckpoint` name generation (first fork, Nth fork, name collision), `applyCheckpointRestore` (skill error collection, missing transient path), schema validation (invalid schema version, missing required fields) |

### Integration tests (runtime, `pytest`)

| Test file | What it covers |
|---|---|
| `test_checkpoint_routes.py` | Save: valid payload, duplicate name overwrite, oversized history (413), path traversal rejection, sandbox-scope enforcement. List: empty workspace, populated workspace. Load: found, not-found (404). Delete: happy path, pinned-checkpoint conflict (409). |
| `test_checkpoint_pin.py` | Pin: happy path (signature embedded, file written, audit event emitted), agent-scoped 403, missing source file (404). Load pinned: valid signature, tampered body (valid: false), missing signature field (valid: false). |

### Browser component harness tests (H2)

| Test | What it covers |
|---|---|
| Checkpoint save button | Name dialog pre-fill, confirm saves, toast appears, picker list updates. |
| Checkpoint restore | Confirm dialog shown, session history replaced, skills re-loaded, badge appears. |
| Auto-pre-restore save | Restoring X automatically saves `pre-restore-<ts>` first. |
| Fork badge | Badge shows fork name; "back to base" triggers restore of parent. |
| HITL banner (Runs Explorer) | Appears when run status is `paused_for_review`, dismissed and not re-shown. |

---

## 11. ROADMAP entry (to add)

```markdown
| **H1** | open | Session checkpoints — save/load/list (draft only). `saveCheckpoint`/`loadCheckpoint`/`listCheckpoints`/`deleteCheckpoint` browser helpers + 4 runtime endpoints + tests. API-only, no UI chrome. |
| **H2** | open | Session checkpoints — fork + UI. `forkCheckpoint`, chat-panel save/restore/fork controls, HITL banner in Runs Explorer, fork badge, full CLI (`benny checkpoint` subcommands). |
| **H3** | open | Session checkpoints — pin. HMAC-signed checkpoints, `pinCheckpoint`/`loadPinnedCheckpoint`, `CHECKPOINT_PINNED` audit event. Mirrors Phase F/F2/F2b for the checkpoint schema. |
```

---

*Prime-Silo — engineered by Binary 16.*

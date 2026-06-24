# Requirements — Phase H: Session Checkpoints

**Status:** draft  
**Phase:** H (H1 → H2 → H3)  
**Author:** Binary 16  
**Date:** 2026-05-12  
**Companion:** [`SOLUTION-H-session-checkpoints.md`](SOLUTION-H-session-checkpoints.md)

---

## 1. Problem statement

An operator working with Prime-Silo moves through several distinct phases in a single session: loading data, running analyses, composing reports, exploring what-if scenarios. There is currently no way to mark a known-good point in this flow and return to it. A single bad prompt, a derailed analysis thread, or a context explosion can force the operator to start from scratch — re-loading data, re-loading skills, re-establishing the analytical stance they had built up.

This is especially costly at two moments:

1. **Before a HITL decision.** A manifest pauses at a `human_review` node. The operator has loaded all context to make a sound decision. Any experimental analysis between now and the decision could contaminate that context. There is no safe way to explore.

2. **Post-run analysis.** A Pypes or swarm run completes. The operator loads the run into the agent session to interrogate it. Without a restore point, every speculative question risks drifting the session away from the grounded starting point.

Session checkpoints solve this by giving operators a way to stamp a named point in their session, branch off it freely, and return to it exactly as it was.

---

## 2. Goals

- **G1.** An operator can save a named checkpoint of their current agent session at any time from the UI or CLI.
- **G2.** An operator can restore any previously saved checkpoint, returning their session to exactly that state.
- **G3.** An operator can fork a checkpoint, creating an isolated branch for experimental work without touching the original.
- **G4.** A human (not the agent) can pin a checkpoint, producing an HMAC-signed, tamper-evident snapshot that is portable and auditable.
- **G5.** A checkpoint carries enough state to be useful without requiring re-setup: conversation history, loaded skills, pre-staged context data, and optional run references.
- **G6.** The CLI supports managing checkpoints (list, delete, inspect, pin) even when no interactive session is running.

---

## 3. Non-goals

- **NG1.** Checkpoints do not snapshot DAG execution state. LangGraph `MemorySaver` and `benny pypes rerun --from` already own that layer.
- **NG2.** Checkpoints do not version manifests. Manifests are HMAC-signed immutable artefacts.
- **NG3.** Checkpoints are not a replacement for draft views (`saveView`). Views capture composed widget layouts; checkpoints capture the session that leads to and surrounds them.
- **NG4.** Auto-merging fork branches back into the main thread is out of scope. The operator decides what, if anything, to carry back.
- **NG5.** Checkpoints do not store binary data (file contents, images). They store references to files and run IDs, not copies.
- **NG6.** Multi-user checkpoint sharing is out of scope for H1 and H2. Pinned checkpoints (H3) are portable but sharing infrastructure is a later concern.

---

## 4. User stories

### 4.1 Save a checkpoint (UI)

> As an operator with a loaded agent session, I want to press a "Save checkpoint" button in the chat panel, give it a name, and have the entire session state preserved so that I can return to it later.

**Acceptance criteria:**

- A "Save checkpoint" control is visible in the chat panel header.
- Clicking it opens a name-entry dialog. The name field pre-fills with a timestamp-based default (e.g. `checkpoint-2026-05-12-1430`).
- On confirm, the checkpoint is saved and a toast confirms the name.
- The checkpoint appears immediately in the checkpoint picker list.
- If a checkpoint with the same name already exists, the UI warns before overwriting.

---

### 4.2 Restore a checkpoint (UI)

> As an operator, I want to select a previously saved checkpoint from a list and restore my session to that state — with the same history, skills, and staged data — so that I can continue analysis from that exact point.

**Acceptance criteria:**

- A checkpoint picker is accessible from the chat panel header (e.g. a dropdown or side panel).
- Selecting a checkpoint shows its metadata: name, saved date, skill count, message count, any attached run IDs.
- Confirming restore replaces the current session history, re-invokes `space.skills.load` for each listed skill, and re-stages any transient context items.
- The chat panel scrolls to the restored history. A system notice appears: `Session restored from checkpoint "my-checkpoint".`
- The previous (discarded) session is automatically saved as a temporary checkpoint named `pre-restore-<timestamp>` so the operator can recover it if the restore was accidental.

---

### 4.3 Fork a checkpoint (UI)

> As an operator about to run a speculative analysis, I want to fork my current checkpoint so I can experiment freely while knowing the base state is untouched.

**Acceptance criteria:**

- Forking is accessible from the checkpoint picker: "Fork" action beside each checkpoint entry.
- Forking creates a new checkpoint named `<original>_fork_<n>` where `n` increments (fork_1, fork_2 …).
- The session switches to the fork immediately (same state, different name).
- The original checkpoint is unmodified.
- The chat panel shows a persistent badge: `Working in fork: my-checkpoint_fork_1`.
- Forked checkpoints appear in the list with a visual indent or fork icon.

---

### 4.4 Save a checkpoint (agent-initiated)

> As an agent mid-turn, I want to be able to save a named checkpoint so that complex multi-turn tasks can create their own restore points without operator intervention.

**Acceptance criteria:**

- The agent runtime exposes `saveCheckpoint(scope, ws, name, state)` callable within a mounted turn.
- The agent cannot overwrite a pinned checkpoint (pinned = human-only, 403 from middleware).
- The agent CAN overwrite its own earlier un-pinned checkpoints.
- Saves from the agent are tagged `source: "agent"` in the checkpoint metadata.
- Saves from the operator UI are tagged `source: "operator"`.

---

### 4.5 HITL integration — auto-checkpoint offer

> As an operator, when a manifest execution pauses at a human-review node, I want the shell to automatically offer to save a checkpoint so I have a clean restore point before I interact with the paused state.

**Acceptance criteria:**

- When the Runs Explorer detects a run with status `paused_for_review`, it surfaces a banner: `Run paused for review. Save a checkpoint before you proceed?`
- One click saves a checkpoint named `pre-hitl-<run_id>`.
- The offer is dismissible (does not re-appear for the same run ID in the same session).

---

### 4.6 Checkpoint anchored to a run (UI + CLI)

> As an operator, I want to save a checkpoint that is anchored to one or more run IDs so that when I restore it, the agent automatically knows which runs are under analysis.

**Acceptance criteria:**

- When saving a checkpoint from the Runs Explorer, the current run ID is automatically included in `run_refs`.
- When saving from the Manifest Explorer, the active manifest ID is included in `manifest_refs`.
- When restoring such a checkpoint, the Runs Explorer auto-selects the anchored run.
- The checkpoint metadata display shows attached run IDs.

---

### 4.7 List checkpoints (CLI)

> As an operator working from the terminal, I want to list all checkpoints in a workspace so I can see what restore points are available without opening the browser.

**Acceptance criteria:**

```
benny checkpoint list --workspace myproject

NAME                        SAVED                STATUS   SKILLS  MSGS  RUNS
checkpoint-2026-05-12-1430  2026-05-12 14:30:00  draft    2       18    run-abc123
pre-hitl-run-abc123         2026-05-12 14:15:00  draft    1       12    run-abc123
analysis-base               2026-05-11 09:00:00  pinned   3       8     —
```

- `STATUS` is `draft` (un-pinned) or `pinned` (HMAC-verified).
- Output supports `--json` for machine consumption.

---

### 4.8 Delete a checkpoint (CLI)

> As an operator, I want to delete a checkpoint by name from the terminal.

**Acceptance criteria:**

- `benny checkpoint delete <name> --workspace myproject` removes the checkpoint file.
- Attempting to delete a pinned checkpoint requires `--force` and prints a warning.
- Deleting a non-existent checkpoint returns a clear error, not a silent success.

---

### 4.9 Inspect a checkpoint (CLI)

> As an operator, I want to inspect the full contents of a checkpoint — metadata, history summary, skills list — without restoring it.

**Acceptance criteria:**

```
benny checkpoint inspect analysis-base --workspace myproject

Checkpoint: analysis-base
Saved:      2026-05-11 09:00:00
Status:     pinned (valid)
Skills:     browser-control, data-analyst
Messages:   8  (system: 1, user: 4, assistant: 3)
Runs:       —
Manifests:  mf-q3-sales
Fork of:    —
Description: "Q3 data loaded, baseline established"
```

- `--verbose` prints the full history as collapsed one-liners per turn.
- Pinned checkpoints report `valid` or `invalid` (HMAC re-verified on read).

---

### 4.10 Pin a checkpoint (CLI + UI)

> As an operator, I want to pin a checkpoint so it becomes HMAC-signed, tamper-evident, and portable — the same guarantee I get from a pinned view.

**Acceptance criteria:**

- CLI: `benny checkpoint pin <name> --workspace myproject`
- UI: "Pin checkpoint" action in the checkpoint picker, same button style as pinning a view.
- Pinning is human-only. Any agent attempt returns 403.
- The pinned file embeds an inline `signature` block (same shape as `.aamp.view`).
- `benny checkpoint inspect` reports `pinned (valid)` or `pinned (invalid)` after re-verifying the HMAC.
- Pinned checkpoints cannot be overwritten without `--force` and lose the `pinned` status on re-write.

---

### 4.11 Template checkpoints (CLI)

> As an operator setting up a workspace for a team, I want to create a checkpoint template via the CLI that pre-defines which skills to load and which run IDs to reference, so that any team member can start from a known, pre-configured analytical starting point without having run the session themselves.

**Acceptance criteria:**

- `benny checkpoint template create <name> --workspace myproject --skills browser-control,data-analyst --runs run-abc123` creates a minimal checkpoint with empty history but pre-populated `skills` and `run_refs`.
- Template checkpoints are valid checkpoints — restoring one loads the skills and surfaces the run in context; history starts empty.
- Templates are tagged `source: "template"` in metadata.
- `benny checkpoint list` shows templates with a `T` indicator in the STATUS column.

---

## 5. Non-functional requirements

| ID  | Requirement                                                                                                                                                      |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| NF1 | Saving a checkpoint must complete in under 500 ms for sessions with ≤ 200 messages.                                                                              |
| NF2 | Restoring a checkpoint must re-load all listed skills and restore history within 2 seconds (excluding network latency for skill load).                           |
| NF3 | Checkpoint files must not exceed 2 MB uncompressed. History beyond this limit is summarised using the existing `compact-prompt-auto.md` mechanism before saving. |
| NF4 | Checkpoints do not store secrets. API keys, tokens, or values matching the pattern of credentials in the history are redacted before save.                       |
| NF5 | The checkpoint list endpoint must respond in under 200 ms for workspaces with ≤ 100 checkpoints.                                                                 |
| NF6 | All checkpoint operations are idempotent server-side — re-saving with the same name and identical content is a no-op with no audit noise.                        |
| NF7 | Pinned checkpoints (H3) must survive `BENNY_HMAC_KEY` rotation detection — `inspect` reports `invalid` rather than silently verifying with a wrong key.          |

---

## 6. Security requirements

| ID  | Requirement                                                                                                                                                                                                                         |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S1  | Checkpoint save and fork are `sandbox`-scoped operations. The runtime's `AgentScopeMiddleware` enforces this — unscopped or `read_only` callers receive 403.                                                                        |
| S2  | Checkpoint list and load are unscoped reads. Any authenticated caller can read a checkpoint regardless of whether an agent scope is active.                                                                                         |
| S3  | Pin is a human-only operation. Any call carrying `X-Benny-Agent-Scope` receives 403 from the middleware, same as `pinView`.                                                                                                         |
| S4  | Checkpoint files live entirely inside `agent_sandbox/checkpoints/`. Path traversal is rejected server-side (no `..`, no absolute paths, single filename component only).                                                            |
| S5  | History content in the checkpoint is stored as-is (not encrypted at rest). Operators are responsible for not putting plaintext secrets into the agent conversation. A best-effort credential redaction pass runs before save (NF4). |
| S6  | Forked checkpoints share the same security model as their origin. A fork inherits the `pinned` status of neither its origin nor any prior fork. Forks are always `draft` until explicitly pinned by a human.                        |

---

## 7. Dependencies

| Dependency                                    | Phase    | Notes                                                                                             |
| --------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------- |
| Phase D2 — agent-context chokepoint           | H1       | `createAgentRuntimeClient(scope)` is the transport for all checkpoint writes.                     |
| Phase D3 — saved-views pattern                | H1       | Checkpoint endpoints follow the identical save/load/list pattern. Reuse server-side path helpers. |
| Phase F2 — `pinView`                          | H3       | `pinCheckpoint` is `pinView` adapted for the checkpoint schema. Reuse the signing pipeline.       |
| Phase F2b — `loadPinnedView`                  | H3       | `loadPinnedCheckpoint` follows the same `{view, signature, valid}` return shape.                  |
| History compaction (`compact-prompt-auto.md`) | H1 (NF3) | Summaries replace full history when the message list exceeds the 2 MB cap.                        |
| `space.skills.load`                           | H1 (4.2) | Restore invokes this for each skill in `checkpoint.skills[]`.                                     |

---

## 8. Out of scope for Phase H

- Syncing checkpoints between machines (beyond pinned files being manually portable).
- Checkpoint diffing (show what changed between two checkpoints).
- Branching UX beyond linear fork numbering (no full Git-style branching tree).
- Automated checkpoint creation on a timer or token-count trigger (could be a Phase H4).
- Checkpoint search or tagging.

---

_Prime-Silo — engineered by Binary 16._

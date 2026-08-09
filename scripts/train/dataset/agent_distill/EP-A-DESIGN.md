# EP-A — Code + Knowledge Agent (tool-use + coding distillation)

Distil **agentic behaviour** — navigate the code + knowledge store, choose the right tool, write
code — into a small fast model that runs as either **analyst** or **developer**. The role is a tool
allowlist + system prompt over ONE set of weights, not separate models. Follows the proven P5 arc
(distil a behaviour from a teacher into a small model, prove it on a non-circular ladder).

## Locked decisions (owner, 2026-08-09)

- **Tool-use signal: clone → teacher-polish.** Bootstrap by behavioural-cloning the successful
  Claude Code trajectories already in the corpus, then use a stronger model to fix/augment the weak
  trajectories the harvester flags. Best quality ceiling.
- **Base model: both, race on the ladder.** Train an adapter on `qwen2.5-coder-7b` (code + tool-call
  strength, already tuned here) AND `gemma-4-e4b` (P5 speed class); the eval ladder picks the winner,
  exactly as E4B-vs-12B was decided.

## The data (grounded in the real store)

Source = the memo-ray entity store (`~/.mem0ray/data`, read via `scripts/longview/lib/store.mjs`
`readTimeline`). 302 sessions indexed. Each session is a tree of typed nodes:

| node type     | role in a training pair                                     |
| ------------- | ---------------------------------------------------------- |
| `User Input`  | task / turn context                                        |
| `Thought`     | assistant reasoning (context; a reasoning target later)    |
| `Message`     | assistant prose (context)                                  |
| `Tool Call`   | **the action to learn** — content is `{"name","input"}`    |
| `Tool Result` | tool output (context for the next action)                  |
| `Artifact`    | produced file (context / coding target)                    |

**Tool-use pair:** `(rendered context up to a Tool Call) → (that Tool Call's JSON)`. Stream `T`.
**Coding pair (phase 2):** `(task + repo context) → (Edit/Write diff that passed a gate)`. Stream `C`.

## Privacy — reused VERBATIM from P5 (non-negotiable)

Same machinery as `build_longview_distill.mjs`: `leak_gate.mjs scanForLeaks`, `longview/quarantine.json`
(CV/job sids excluded outright), `personal_terms.json`. Per-session gate, **response-hard /
input-strong** (owner-signed 2026-08-05): the Tool Call we TEACH is scanned with the full net
(incl. coarse `cv`); the context transcript with strong terms (≥4-char names/emails) + quarantined
sids. Whole-session exclude, deterministic sha256 held-out split, fail-closed backstop asserts 0.
Rows git-ignored. Never weaken `personal_terms.json` to make a build pass. See
`training-data-privacy` memory.

## Tool surface (the agent's runtime — ~80% already built)

- Knowledge nav: `search_sessions`, `query_graph`, `read_card(sid)`, `walk_lineage` (record.mjs /
  memory.mjs / dashboard lineage).
- Code nav: `grep`, `read_file`, `list_dir`, `code_graph_query` (`benny enrich`).
- Role-gated actions: **analyst** = read-only + `write_draft` (→ `agent_sandbox/drafts`);
  **developer** = + `write_file`, `run_gate`, `run_tests`, sandboxed to the ADR-001 determinism
  boundary. Role = exposed toolset, same weights.

## Build order

1. **Trajectory harvester** (`build_agent_traces.mjs`) — clone stage: emit stream-`T` tool-use pairs
   + held-out split + privacy gate. ← _this step_
2. Outcome tagging + **teacher-polish** of weak trajectories.
3. Tool-surface schema (JSON tool defs the model emits against) + `format.py` stream `T`.
4. Dual-base QLoRA (qwen-coder + e4b), reusing the P5 trainer.
5. **Ladder eval**: next-tool-call trajectory match + held-out task-completion gate; ladder picks base.

## Non-circular eval

Tool-use = does the model emit the correct next Tool Call given context (trajectory match on held-out
sessions) + a completion gate (did its trajectory reach green on held-out tasks). Coding = does the
emitted diff pass the task's gate. Never "match the teacher token-for-token".

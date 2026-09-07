# Estate use cases

_What people and machinery actually do here, and which surface each act happens on_

17 use cases · 16 surfaces, all covered · 
9 exercised, 8 declared

## Actors

Actors are the estate's own authorship enum (R38) — human, frontier, house — plus external for another node. The estate already records who caused every event in exactly these terms, so a use case naming a different cast of actors would be describing a different system.

- **You (the owner)** (`human`) — The only actor who may sign. Everything consequential terminates in a decision here.
- **Benny (the agent)** (`frontier`) — May propose and may never authorise (ADR-001). Reads, drafts, raises.
- **The estate (deterministic machinery)** (`house`) — Scheduled tasks, folds, sweeps and gates. Emits facts; exercises no judgement.
- **Another node** (`external`) — optimus, homeassistant, or a publisher we fetch from. Reachable, not trusted.

## What "exercised" and "declared" mean

`exercised` means this flow was run end to end against the live estate and its result observed. `declared` means it is taken from the surface's own registered description and has NOT been run. The difference is recorded because a use-case map that reads uniformly confident about both is the same lie as a gauge reporting zero from an empty population.

## UC-01 · Authorise a piece of work

**Actor** You (the owner) · **exercised**

**Goal** Turn a proposal into an authorisation the rest of the estate can cite.

**Trigger** Something is waiting in the signing queue.

**Precondition** The governance ledger's hash chain verifies.

**Surfaces** Gov (`#/_prime_silo/gov`)

**Endpoints** `/api/gov_proposals` · `/api/gov_sign`

**Flow**

1. Open the Gov arc. Each card shows why, what it rests on, what it costs and whether it reverses — before any button.
2. Read the evidence disclosure if the decision turns on it.
3. Sign, or decline with a reason.

**Outcome** A proposal_signed event with authorship human and your identity from the session.

**What it refuses to do**

- The client cannot choose the signer.
- Signing onto a ledger whose chain does not verify is refused.

## UC-02 · Raise work for a decision

**Actor** Benny (the agent) · **exercised**

**Goal** Put a finding forward without acting on it.

**Trigger** The agent, or a script, finds work worth doing.

**Precondition** The governance chain verifies.

**Endpoints** `/api/gov_raise`

**Flow**

1. POST /api/gov_raise with a proposalId, title, rationale and any derivedFrom subjects.
2. The proposal appears in the Gov queue and nothing else happens.
3. An identical re-raise writes nothing; a changed one refreshes in place.

**Outcome** A proposal_raised event with authorship frontier, awaiting a human.

**What it refuses to do**

- A proposal without a rationale is refused.
- A settled proposal cannot be re-raised.
- derivedFrom must be subject ids, never prose.

> **Gap** — There is no screen for this. Raising is reachable only from a command line or an agent — see the sitemap's routes-with-no-panel.

## UC-03 · Prove where a thing came from

**Actor** You (the owner) · **exercised**

**Goal** Answer 'who caused this, and on whose authority' for any subject in the estate.

**Trigger** A reviewer asks, or something looks wrong.

**Precondition** An estate store exists and its ledgers verify.

**Surfaces** Lineage (`#/_prime_silo/lineage`)

**Endpoints** `/api/lineage_index` · `/api/lineage_trail`

**Flow**

1. Open the Lineage arc. Coverage is shown before the rows, on purpose.
2. Filter by kind and pick the subject.
3. Read its parents, its machines, and the authorship split.

**Outcome** The subject's full recorded history, with what is NOT recorded stated plainly.

**What it refuses to do**

- A subject from a failing ledger is shown but never counted as evidence.
- Edges are declared, never inferred.
- Ledger-to-world completeness reports NOT MEASURABLE without a sweep.

## UC-04 · Replay what happened, step by step

**Actor** You (the owner) · **exercised**

**Goal** Walk an execution one event at a time and see what the system believed at each point.

**Trigger** Understanding an outcome after the fact.

**Precondition** The subject has more than one recorded event.

**Surfaces** Lineage (`#/_prime_silo/lineage`) · Step-Through (`#/_prime_silo/step_through`) · Time Travel (`#/time_travel`)

**Endpoints** `/api/lineage_trail`

**Flow**

1. Select the subject; the trail opens on the most recent event.
2. Prev / Next, or the arrow keys, walk the history.
3. The tick rail colours each event by who caused it.

**Outcome** The event's own payload plus the projection the system would have returned then.

**What it refuses to do**

- The projector is last-write-wins, so the field is called projection, not state — earlier facts are absent, never retracted.

## UC-05 · Onboard an application

**Actor** You (the owner) · **exercised**

**Goal** Bring new software into the estate so it is authorised, stored once, placed everywhere and remembered.

**Trigger** You want an application on one or more machines.

**Precondition** The estate store is reachable.

**Surfaces** Gov (`#/_prime_silo/gov`)

**Commands** `scripts/app_onboard.mjs` · `scripts/manual_build.mjs`

**Flow**

1. propose — writes a proposal and stops. Nothing is fetched.
2. decide — you sign in the Gov arc. There is no way to skip this.
3. acquire — fetches once into the content-addressed store, citing the signature.
4. place — materialises a copy per machine, each recording the same cause.
5. remember — rebuild the manual so the agent knows the application exists.

**Outcome** An installed application whose entire path is provable from the ledger.

**What it refuses to do**

- acquire and place refuse while the proposal is open, declined or absent.
- There is no --force.

## UC-06 · Download once, use everywhere

**Actor** You (the owner) · **exercised**

**Goal** Stop paying for the same file twice across machines.

**Trigger** A release, installer or model is needed on more than one node.

**Precondition** The publisher gives a hash, or you accept fetching once to learn it.

**Surfaces** Files (`#/file_explorer`)

**Commands** `scripts/artifact.mjs`

**Flow**

1. acquire with --expected-hash; if the blob is held the source is never opened.
2. place it on each machine that needs it.
3. ls shows what is held and where every copy lives.
4. evict retires a copy; the blob survives.

**Outcome** One stored copy, many recorded placements, and a transfer-avoided figure that is real.

**What it refuses to do**

- A --caused-by naming a proposal must name one a human actually signed.
- Eviction never destroys the blob.

## UC-07 · Notice that a machine has gone quiet

**Actor** The estate (deterministic machinery) · **exercised**

**Goal** Know which nodes and services are alive without assuming silence means health.

**Trigger** The scheduled sweep, every five minutes; the collector, every fifteen.

**Precondition** Each node writes its own chained log.

**Surfaces** Mission Control (`#/_prime_silo/mission_control`) · Bridge (`#/_prime_silo/bridge`)

**Commands** `scripts/heartbeat_run.mjs` · `scripts/heartbeat_estate.mjs`

**Flow**

1. Each node sweeps its own services and records only transitions.
2. The collector pulls the remote logs and folds one board.
3. A node that stopped reporting is carried as a blind spot.

**Outcome** A board that distinguishes 'down' from 'not heard from'.

**What it refuses to do**

- Chains are never concatenated.
- A failed pull must not make a node vanish from the board.

## UC-08 · Hand a reviewer the evidence

**Actor** You (the owner) · **exercised**

**Goal** Produce, from cold, a document that shows whether the estate is governed — including what cannot be shown.

**Trigger** An audit, or your own periodic check.

**Precondition** Ledgers exist; a sweep can reach the store.

**Surfaces** Manifests (`#/_prime_silo/manifest_explorer`)

**Commands** `scripts/evidence_pack.mjs` · `scripts/inventory_sweep.mjs`

**Flow**

1. Run the sweep to reconcile disk against ledger.
2. Generate the pack; read the verdict before the table.
3. Check the 'Of' column: a count means nothing without its population.

**Outcome** One document a reviewer can read without a tour of the codebase.

**What it refuses to do**

- NOT MEASURABLE never masquerades as clean.
- A gauge with an empty population is named as vacuous.
- Exit 0 only when every defect is measured, zero and non-empty.

## UC-09 · Ask the estate a question about itself

**Actor** You (the owner) · **exercised**

**Goal** Get an answer from the operating manual rather than from the model's general knowledge.

**Trigger** You do not remember how something works.

**Precondition** The manual has been built and loaded; an embedding model and a chat model are served.

**Surfaces** Agent (`#/agent`) · Local LLM (`#/huggingface`)

**Commands** `scripts/manual_build.mjs` · `scripts/manual_load.mjs`

**Flow**

1. Build the manual from manual.json; the build fails rather than describe something absent.
2. Load it: graph triples for traversal, chunks for retrieval, a PageIndex tree for navigation.
3. Ask. Answers are graded for groundedness and labelled.

**Outcome** An answer traceable to a section of the manual, or an honest 'I do not know'.

**What it refuses to do**

- A partial load is reported as partial, never as success.
- Ungrounded answers come back flagged, not silently.

## UC-10 · Recall what was done in a past session

**Actor** You (the owner) · **declared**

**Goal** Find the work, the reasoning and the artefacts of an earlier session.

**Trigger** Picking up something started days or weeks ago.

**Precondition** The memory graph has scanned the relevant agent activity.

**Surfaces** Memory (`#/_prime_silo/memory`) · Lifelog (`#/_prime_silo/lifelog`) · Session Graph (`#/_prime_silo/session_graph`) · Memory Setup (`#/_prime_silo/setup`)

**Flow**

1. Configure where the memory graph scans (Memory Setup).
2. Search or browse sessions in Memory; the Lifelog gives the same span as a timeline of commits and agent actions.
3. Open one session in the Session Graph to walk its recursive inputs and outputs.

**Outcome** The session, its lineage, and what it produced.

## UC-11 · See how the pipeline produced an output

**Actor** You (the owner) · **declared**

**Goal** Inspect the model calls, gate verdicts and retrievals behind a generated artefact.

**Trigger** An output looks wrong, or needs defending.

**Precondition** The run was recorded.

**Surfaces** Benny Record (`#/_prime_silo/benny_record`)

**Flow**

1. Open Benny Record and select the output.
2. Replay the production path: every model call, gate verdict and retrieval.

**Outcome** The chain of steps that produced the artefact.

## UC-12 · Inspect a signed manifest

**Actor** You (the owner) · **declared**

**Goal** Read what a deterministic-zone manifest will do before it runs.

**Trigger** Reviewing planned work an agent has drafted.

**Precondition** The manifest is registered.

**Surfaces** Manifests (`#/_prime_silo/manifest_explorer`)

**Flow**

1. Open Manifests and pick the registered manifest.
2. Read it as a DAG rather than as JSON.

**Outcome** An understanding of the planned execution, before authorising it.

## UC-13 · Watch the whole mesh at once

**Actor** You (the owner) · **declared**

**Goal** See memory, documents, code, flows and runs in one place.

**Trigger** Starting a session, or checking on long-running work.

**Precondition** The runtime is reachable.

**Surfaces** Bridge (`#/_prime_silo/bridge`) · Mission Control (`#/_prime_silo/mission_control`)

**Flow**

1. Open Mission Control for the ecosystem rollup, resources and capabilities.
2. Open Bridge for the cognitive mesh across memory, documents, code, flows and runs.

**Outcome** Current state without opening five screens.

## UC-14 · Hold and edit the estate's own files

**Actor** You (the owner) · **declared**

**Goal** Browse and change app files without leaving the estate.

**Trigger** A configuration or content change.

**Precondition** You are signed in.

**Surfaces** Files (`#/file_explorer`)

**Flow**

1. Open Files, navigate to the file, edit it.

**Outcome** The file is changed.

## UC-15 · Serve and test a local model

**Actor** You (the owner) · **declared**

**Goal** Run a model on this machine rather than sending work elsewhere.

**Trigger** Needing generation or embeddings locally.

**Precondition** A model is present on disk.

**Surfaces** Local LLM (`#/huggingface`)

**Flow**

1. Open Local LLM.
2. Load a model and test it with WebGPU or Hugging Face.

**Outcome** A model serving locally, which the rest of the estate can use.

## UC-16 · Undo a change to the estate's own configuration

**Actor** You (the owner) · **declared**

**Goal** Roll back settings, spaces or custom development changes.

**Trigger** A change made things worse.

**Precondition** The prior state was captured.

**Surfaces** Time Travel (`#/time_travel`)

**Flow**

1. Open Time Travel and select what to undo.

**Outcome** The earlier configuration is restored.

## UC-17 · Manage the operator account

**Actor** You (the owner) · **declared**

**Goal** Keep the identity that signs things correct and secured.

**Trigger** A name or password change.

**Precondition** You are signed in.

**Surfaces** User (`#/user`)

**Flow**

1. Open User and update your name or password.

**Outcome** The identity the signing path reads from the session is current.

> This matters more than it looks: gov_sign takes the signer from the session, so this surface defines who the ledger will name.

## Coverage

| Zone | Surface | Use cases |
| --- | --- | --- |
| Decide | Gov | UC-01, UC-05 |
| Prove | Benny Record | UC-11 |
| Prove | Lineage | UC-03, UC-04 |
| Prove | Manifests | UC-08, UC-12 |
| Watch | Bridge | UC-07, UC-13 |
| Watch | Mission Control | UC-07, UC-13 |
| Recall | Lifelog | UC-10 |
| Recall | Memory | UC-10 |
| Recall | Memory Setup | UC-10 |
| Recall | Session Graph | UC-10 |
| Replay | Step-Through | UC-04 |
| Replay | Time Travel | UC-04, UC-16 |
| Ask | Agent | UC-09 |
| Hold | Files | UC-06, UC-14 |
| Think | Local LLM | UC-09, UC-15 |
| Operate | User | UC-17 |

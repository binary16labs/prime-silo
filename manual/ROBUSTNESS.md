# Estate robustness diagrams

_Boundary, control and entity for every process that was actually run_

ICONIX robustness analysis has real rules, not stylistic ones: an actor may touch only a boundary, an entity may be touched only by a control, and boundaries never talk to each other or reach a store directly. A diagram that breaks them is not untidy — it describes a design where a screen writes to a ledger, or a person reaches past the interface. Those rules are enforced here, so drawing the wrong architecture fails the build.

## The four rules

| | may connect to |
| --- | --- |
| **Actor** | boundary only |
| **Boundary** | actors and controls |
| **Control** | boundaries, entities, other controls |
| **Entity** | controls only |

Anything else is a design defect the notation exists to reveal, and fails this build.

9 diagrams · 28 boundaries · 42 controls · 27 entities

## R-01 · Authorise a piece of work

Flow F-01 · use cases UC-01

```mermaid
flowchart LR
  owner(("You (owner)"))
  govArc["Gov arc"]
  proposalsApi["GET /api/gov_proposals"]
  signApi["POST /api/gov_sign"]
  verifyChain(["Verify the hash chain"])
  foldGov(["Fold events into proposals"])
  resolveSigner(["Take the signer from the session"])
  appendSigned(["Append the signature, authorship hard-coded human"])
  govLedger[("governance.jsonl")]
  proposal[("Proposal subject")]
  requestQueue(["Request the queue"])
  owner -- "opens the queue" --> govArc
  proposalsApi --> verifyChain
  verifyChain -- "reads raw lines" --> govLedger
  verifyChain -- "only if intact" --> foldGov
  foldGov -- "projects" --> proposal
  govArc -- "shows why, cost, reversibility BEFORE the buttons" --> owner
  owner -- "signs or declines" --> signApi
  signApi --> resolveSigner
  resolveSigner -- "identity never from the request" --> appendSigned
  appendSigned -- "appends" --> govLedger
  govArc --> requestQueue
  requestQueue --> proposalsApi
```

**Boundary** — Gov arc · GET /api/gov_proposals · POST /api/gov_sign

**Control** — Verify the hash chain · Fold events into proposals · Take the signer from the session · Append the signature, authorship hard-coded human · Request the queue

**Entity** — governance.jsonl · Proposal subject

## R-02 · Raise work for a decision

Flow F-02 · use cases UC-02

```mermaid
flowchart LR
  benny(("Benny"))
  raiseApi["POST /api/gov_raise"]
  validate(["Require a rationale; reject prose edges"])
  idempotence(["Identical re-raise writes nothing"])
  terminalGuard(["A settled proposal cannot be re-raised"])
  appendRaised(["Append raised, authorship hard-coded frontier"])
  govLedger[("governance.jsonl")]
  proposal[("Proposal subject")]
  benny -- "proposes" --> raiseApi
  raiseApi --> validate
  validate --> idempotence
  idempotence -- "compares against the fold" --> proposal
  idempotence --> terminalGuard
  terminalGuard -- "only if open or new" --> appendRaised
  appendRaised -- "appends" --> govLedger
  raiseApi -- "201, or a refusal with the reason" --> benny
```

**Boundary** — POST /api/gov_raise

**Control** — Require a rationale; reject prose edges · Identical re-raise writes nothing · A settled proposal cannot be re-raised · Append raised, authorship hard-coded frontier

**Entity** — governance.jsonl · Proposal subject

## R-03 · Onboard an application

Flow F-03 · use cases UC-05

```mermaid
flowchart LR
  owner(("You (owner)"))
  onboardCli["app_onboard.mjs"]
  govArc["Gov arc"]
  requireSig(["Require a human signature — no --force"])
  acquire(["Acquire once, citing the signature"])
  place(["Place per machine, recording the cause"])
  recordRun(["Record the execution"])
  govLedger[("governance.jsonl")]
  blobStore[("Content-addressed blob store")]
  artLedger[("artifacts.jsonl")]
  runsLedger[("runs.jsonl")]
  appRecord[("manual/apps/<id>.json")]
  recordApp(["Record the application"])
  manualCli["manual_build.mjs"]
  rebuild(["Rebuild so the agent knows it exists"])
  owner -- "propose / acquire / place" --> onboardCli
  onboardCli --> requireSig
  requireSig -- "resolves the proposal" --> govLedger
  owner -- "decides" --> govArc
  govArc -- "the signature it produced" --> requireSig
  requireSig -- "only when signed" --> acquire
  acquire -- "stores once" --> blobStore
  acquire -- "records acquisition" --> artLedger
  acquire --> place
  place -- "records a placement per node" --> artLedger
  place --> recordRun
  recordRun --> runsLedger
  onboardCli --> recordApp
  recordApp --> appRecord
  owner -- "remember" --> manualCli
  manualCli --> rebuild
  rebuild -- "reads the onboarded app" --> appRecord
```

**Boundary** — app_onboard.mjs · Gov arc · manual_build.mjs

**Control** — Require a human signature — no --force · Acquire once, citing the signature · Place per machine, recording the cause · Record the execution · Record the application · Rebuild so the agent knows it exists

**Entity** — governance.jsonl · Content-addressed blob store · artifacts.jsonl · runs.jsonl · manual/apps/<id>.json

## R-04 · Acquire an artifact once

Flow F-04 · use cases UC-06

```mermaid
flowchart LR
  owner(("You (owner)"))
  publisher(("Publisher"))
  artifactCli["artifact.mjs"]
  verifyCitation(["A cited proposal must be human-signed"])
  holdCheck(["Ask before opening the source"])
  streamHash(["Hash while writing; verify before rename"])
  recordRun(["Record the execution, authorised or not"])
  govLedger[("governance.jsonl")]
  blobStore[("Content-addressed blob store")]
  artLedger[("artifacts.jsonl")]
  runsLedger[("runs.jsonl")]
  filesArc["Files"]
  owner -- "acquire --caused-by" --> artifactCli
  artifactCli --> verifyCitation
  verifyCitation -- "resolves the signature" --> govLedger
  verifyCitation --> holdCheck
  holdCheck -- "do we already hold this hash?" --> blobStore
  holdCheck -- "only when not held" --> streamHash
  publisher -- "serves the bytes" --> artifactCli
  streamHash -- "atomic rename after verifying" --> blobStore
  streamHash -- "acquisition + verification" --> artLedger
  holdCheck --> recordRun
  recordRun --> runsLedger
  filesArc -- "browse what is held and where" --> holdCheck
```

**Boundary** — artifact.mjs · Files

**Control** — A cited proposal must be human-signed · Ask before opening the source · Hash while writing; verify before rename · Record the execution, authorised or not

**Entity** — governance.jsonl · Content-addressed blob store · artifacts.jsonl · runs.jsonl

## R-05 · Prove and replay a subject

Flow F-05 · use cases UC-03, UC-04

```mermaid
flowchart LR
  owner(("You (owner)"))
  lineageArc["Lineage arc"]
  indexApi["GET /api/lineage_index"]
  trailApi["GET /api/lineage_trail"]
  verifyEach(["Verify each chain separately"])
  foldSubjects(["Fold every ledger by subject id"])
  coverage(["Measure what is attested and what is not"])
  project(["Fold each prefix with the system's own projector"])
  ledgers[("Every ledger under the store")]
  subject[("Subject and its trail")]
  requestIndex(["Request the index"])
  stepArc["Step-Through"]
  ttArc["Time Travel"]
  owner -- "opens" --> lineageArc
  indexApi --> verifyEach
  verifyEach -- "reads, chain by chain" --> ledgers
  verifyEach -- "quarantines a failing ledger" --> foldSubjects
  foldSubjects -- "indexes by sid" --> subject
  foldSubjects --> coverage
  lineageArc -- "coverage first, rows second" --> owner
  owner -- "picks a subject" --> trailApi
  trailApi --> project
  project -- "reads the ordered events" --> subject
  lineageArc --> requestIndex
  requestIndex --> indexApi
  stepArc -- "the same trail, one action at a time" --> project
  ttArc -- "undo a recorded change" --> project
```

**Boundary** — Lineage arc · GET /api/lineage_index · GET /api/lineage_trail · Step-Through · Time Travel

**Control** — Verify each chain separately · Fold every ledger by subject id · Measure what is attested and what is not · Fold each prefix with the system's own projector · Request the index

**Entity** — Every ledger under the store · Subject and its trail

## R-06 · Prove the estate to a reviewer

Flow F-06 · use cases UC-08

```mermaid
flowchart LR
  owner(("You (owner)"))
  sweepCli["inventory_sweep.mjs"]
  packCli["evidence_pack.mjs"]
  observe(["Walk the roots; observe, do not judge"])
  reconcile(["Reconcile by path; unseen is neither"])
  measure(["Measure each defect over a stated population"])
  verdict(["Refuse to call vacuous or unmeasured clean"])
  disk[("The filesystem as observed")]
  ledgers[("Every ledger under the store")]
  snapshot[("Sweep snapshot in the CAS")]
  pack[("evidence-pack.md")]
  manifestsArc["Manifests"]
  owner -- "runs the sweep" --> sweepCli
  sweepCli --> observe
  observe -- "walks" --> disk
  observe --> reconcile
  reconcile -- "compares claims" --> ledgers
  reconcile -- "stores the observation it judged" --> snapshot
  owner -- "generates the pack" --> packCli
  packCli --> measure
  measure --> ledgers
  measure --> verdict
  verdict -- "writes the verdict and its populations" --> pack
  packCli -- "exit 0 only when substantiated" --> owner
  manifestsArc -- "inspect the signed manifests behind runs" --> measure
```

**Boundary** — inventory_sweep.mjs · evidence_pack.mjs · Manifests

**Control** — Walk the roots; observe, do not judge · Reconcile by path; unseen is neither · Measure each defect over a stated population · Refuse to call vacuous or unmeasured clean

**Entity** — The filesystem as observed · Every ledger under the store · Sweep snapshot in the CAS · evidence-pack.md

## R-07 · Keep the estate's health honest

Flow F-07 · use cases UC-07

```mermaid
flowchart LR
  estate(("The estate (scheduler)"))
  node(("Another node"))
  sweepCmd["heartbeat_run.mjs"]
  collectCmd["heartbeat_estate.mjs"]
  missionArc["Mission Control"]
  probe(["Probe services"])
  transitionOnly(["Record transitions, not observations"])
  merge(["Fold per-node logs without joining chains"])
  blindSpot(["Carry a stale node instead of dropping it"])
  nodeLog[("heartbeat-<node>.jsonl")]
  board[("Estate board")]
  bridgeArc["Bridge"]
  estate -- "every 5 minutes" --> sweepCmd
  sweepCmd --> probe
  probe --> transitionOnly
  transitionOnly -- "appends only on change" --> nodeLog
  estate -- "every 15 minutes" --> collectCmd
  node -- "serves its own log over SSH" --> collectCmd
  collectCmd --> merge
  merge -- "verifies each chain alone" --> nodeLog
  merge --> blindSpot
  blindSpot -- "silence is carried, never dropped" --> board
  missionArc -- "reads the folded view" --> merge
  bridgeArc -- "the same folded view, across the mesh" --> merge
```

**Boundary** — heartbeat_run.mjs · heartbeat_estate.mjs · Mission Control · Bridge

**Control** — Probe services · Record transitions, not observations · Fold per-node logs without joining chains · Carry a stale node instead of dropping it

**Entity** — heartbeat-<node>.jsonl · Estate board

## R-08 · Answer from the manual rather than from memory

Flow F-08 · use cases UC-09

```mermaid
flowchart LR
  owner(("You (owner)"))
  buildCli["manual_build.mjs"]
  loadCli["manual_load.mjs"]
  agentArc["Agent arc"]
  resolveRefs(["Resolve every file, panel, route and command"])
  chunk(["Split one chunk per invariant"])
  route(["Route the question; never answer a domain question from memory"])
  ground(["Grade the answer against its sources"])
  manifest[("manual/manual.json")]
  graph[("Knowledge graph")]
  vectors[("Retrieval index")]
  tree[("PageIndex section tree")]
  llmArc["Local LLM"]
  owner -- "builds the manual" --> buildCli
  buildCli --> resolveRefs
  resolveRefs -- "reads the single source" --> manifest
  resolveRefs -- "only if everything resolves" --> chunk
  owner -- "loads it" --> loadCli
  loadCli --> chunk
  chunk -- "deterministic triples" --> graph
  chunk -- "self-contained chunks" --> vectors
  chunk -- "headings become sections" --> tree
  owner -- "asks" --> agentArc
  agentArc --> route
  route -- "reads the outline first" --> tree
  route -- "retrieves" --> vectors
  route --> ground
  ground -- "answer, labelled grounded or not" --> agentArc
  route -- "calls the served model" --> llmArc
  ground -- "grades with the same model" --> llmArc
```

**Boundary** — manual_build.mjs · manual_load.mjs · Agent arc · Local LLM

**Control** — Resolve every file, panel, route and command · Split one chunk per invariant · Route the question; never answer a domain question from memory · Grade the answer against its sources

**Entity** — manual/manual.json · Knowledge graph · Retrieval index · PageIndex section tree

## R-09 · Read the estate from across the room

Flow F-09 · use cases UC-18

```mermaid
flowchart LR
  owner(("You (owner)"))
  room(("Anyone else in the room"))
  deckArc["Deck (arc and /deck wall)"]
  stateApi["GET /api/deck_state"]
  voiceApi["POST /api/deck_voice"]
  foldOnce(["Fold every ledger into one answer"])
  redact(["Room mode: hide names, titles and paths"])
  diff(["Move only the tile whose figure changed"])
  transcribe(["Transcribe what was said"])
  intent(["Route the intent — with no path to a signature"])
  ledgers[("Every ledger under the store")]
  proposal[("Proposal subject")]
  requestState(["Request the estate's state"])
  owner -- "glances, or engages" --> deckArc
  stateApi --> foldOnce
  foldOnce -- "reads once, so the wall cannot disagree with itself" --> ledgers
  foldOnce --> redact
  redact -- "what is safe to project" --> deckArc
  foldOnce --> diff
  diff -- "motion only on a real change" --> deckArc
  room -- "can read the wall, and can speak" --> deckArc
  owner -- "holds the key and speaks" --> voiceApi
  voiceApi --> transcribe
  transcribe --> intent
  intent -- "may raise — never sign" --> proposal
  intent -- "navigates or answers" --> deckArc
  deckArc --> requestState
  requestState --> stateApi
```

**Boundary** — Deck (arc and /deck wall) · GET /api/deck_state · POST /api/deck_voice

**Control** — Fold every ledger into one answer · Room mode: hide names, titles and paths · Move only the tile whose figure changed · Transcribe what was said · Route the intent — with no path to a signature · Request the estate's state

**Entity** — Every ledger under the store · Proposal subject

# Prime-Silo Operating Manual

What the estate does, how to work it, and what each part refuses to do

## Doctrine

The rules every other section obeys.

### Rule 1

Agents propose; humans sign. An agent may never authorise its own work (ADR-001, R38).

### Rule 2

The ledger records what happened, including what happened badly. A register holding only successes answers a different question than the one asked.

### Rule 3

Absence is a finding, not a pass. 'Not measurable', 'unseen' and 'nothing to measure' each get their own words and are never dressed as clean.

### Rule 4

Provenance is declared, never inferred. A guessed edge is indistinguishable from a real one, which defeats the audit.

## Gov arc

The Gov arc exists to decide. It renders at #/_prime_silo/gov.

### Raise a proposal

Raise a proposal (Gov arc). Put work forward for a decision. This is where every causal chain in the estate begins. How to use it: POST /api/gov_raise with proposalId, title, rationale, and optionally derivedFrom. Re-raising with identical content writes nothing; changed content refreshes the open proposal in place. A settled proposal cannot be re-raised — choose a new id if the situation genuinely changed.

#### Raise a proposal refusal 1

Raise a proposal (Gov arc) refuses to do this: authorship is hard-coded frontier: a request is a program, never a person. Who asked is kept separately as requested_by. Also called: propose, proposal, raise.

#### Raise a proposal refusal 2

Raise a proposal (Gov arc) refuses to do this: A proposal without a rationale is refused — the signer decides on the why, not the title. Also called: propose, proposal, raise.

#### Raise a proposal refusal 3

Raise a proposal (Gov arc) refuses to do this: derivedFrom must be subject ids, never prose; a reason is not a reference. Also called: propose, proposal, raise.

### Sign or decline

Sign or decline (Gov arc). The one place authorisation is granted in the whole estate. How to use it: Open the Gov arc. Each card shows why, what it rests on, what it costs and whether it reverses — all before the buttons. Sign is the single primary action. Decline sits beside it, quiet but recorded. Evidence is a disclosure, not a third competing button.

#### Sign or decline refusal 1

Sign or decline (Gov arc) refuses to do this: The client cannot choose the signer — identity comes from the session, and a signer in the request body is ignored. Also called: signature, authorise, approve, sign off, Gov arc.

#### Sign or decline refusal 2

Sign or decline (Gov arc) refuses to do this: Only a human signs: authorship is hard-coded, not a parameter. Also called: signature, authorise, approve, sign off, Gov arc.

#### Sign or decline refusal 3

Sign or decline (Gov arc) refuses to do this: Declines are kept. A register of approvals only would imply everything proposed was accepted. Also called: signature, authorise, approve, sign off, Gov arc.

#### Sign or decline refusal 4

Sign or decline (Gov arc) refuses to do this: Signing is refused onto a ledger whose chain does not verify. Also called: signature, authorise, approve, sign off, Gov arc.

## Lineage arc

The Lineage arc exists to prove. It renders at #/_prime_silo/lineage.

### The event ledger

The event ledger (Lineage arc). Every fact the estate knows is an append-only, hash-chained event with two timestamps and an author. How to use it: Each ledger is one file under <estate-store>/eventlog/, and each is its own hash chain. Chains are never concatenated — joining two logs breaks every prev hash from the join onward. Read state by folding events, never by trusting a cached projection.

#### The event ledger refusal 1

The event ledger (Lineage arc) refuses to do this: authorship is exactly human | frontier | house — nothing else is valid. Also called: KEL, event log, eventlog, ledger, hash chain.

#### The event ledger refusal 2

The event ledger (Lineage arc) refuses to do this: valid_time is when a thing was true; txn_time is when we learned it; time_confidence says which of those was measured. Also called: KEL, event log, eventlog, ledger, hash chain.

#### The event ledger refusal 3

The event ledger (Lineage arc) refuses to do this: A broken chain quarantines its own ledger and no others. Also called: KEL, event log, eventlog, ledger, hash chain.

### Total lineage

Total lineage (Lineage arc). Every subject the estate has recorded, folded from every ledger, with an honest measure of what is missing. How to use it: Open the Lineage arc. Coverage comes before the rows on purpose. Four figures: ledgers verified, subjects attested, origin recorded, and ledger-vs-world. Filter by kind, then pick a subject to walk its history.

#### Total lineage refusal 1

Total lineage (Lineage arc) refuses to do this: A subject from a failing ledger is shown but never counted as evidence. Also called: provenance, audit trail, where did this come from.

#### Total lineage refusal 2

Total lineage (Lineage arc) refuses to do this: Edges exist only where an event declares derived_from or caused_by. Nothing is inferred. Also called: provenance, audit trail, where did this come from.

#### Total lineage refusal 3

Total lineage (Lineage arc) refuses to do this: Ledger-to-world completeness is NOT MEASURABLE without an inventory sweep, and says so. Also called: provenance, audit trail, where did this come from.

### Step through a subject's history

Step through a subject's history (Lineage arc). Replay any subject one event at a time, seeing what the system believed at each step. How to use it: Select a subject in the Lineage arc; it opens on the most recent event. Prev / Next walk the trail, or press the left and right arrow keys. The tick rail colours each event by who caused it — human, frontier or house.

#### Step through a subject's history refusal 1

Step through a subject's history (Lineage arc) refuses to do this: The projection at each step is computed with the system's own projector, so a replay can never drift from live state. Also called: replay, step through, history, time travel.

#### Step through a subject's history refusal 2

Step through a subject's history (Lineage arc) refuses to do this: That projector is last-write-wins per subject, not accumulating — the field is called projection, not state, and the page says so. Also called: replay, step through, history, time travel.

#### Step through a subject's history refusal 3

Step through a subject's history (Lineage arc) refuses to do this: The event's own payload is always shown in full and is never lossy. Also called: replay, step through, history, time travel.

### Where a thing came from

Where a thing came from (Lineage arc). Two payload fields carry the estate's whole genealogy: derived_from and caused_by. How to use it: Pass --derived-from / --caused-by to the artifact CLI, or derivedFrom / causedBy to the raise API. derived_from is a list (a thing may be made from many); caused_by is single (one decision brought it about). Read the result as ORIGIN RECORDED in the Lineage arc.

#### Where a thing came from refusal 1

Where a thing came from (Lineage arc) refuses to do this: An edge must be a subject id, never prose — a reason written as a reference becomes a dangling parent forever. Also called: derived_from, caused_by, origin.

#### Where a thing came from refusal 2

Where a thing came from (Lineage arc) refuses to do this: Nothing is its own ancestor. Also called: derived_from, caused_by, origin.

#### Where a thing came from refusal 3

Where a thing came from (Lineage arc) refuses to do this: Absent is not empty: with no provenance the keys are omitted, because [] would assert 'derived from nothing'. Also called: derived_from, caused_by, origin.

## Mission Control arc

The Mission Control arc exists to watch. It renders at #/_prime_silo/mission_control.

### Estate heartbeat

Estate heartbeat (Mission Control arc). Know which machines and services are alive, and notice silence rather than assuming health. How to use it: node scripts/heartbeat_run.mjs --machine <name> — one node's sweep, scheduled every 5 minutes. node scripts/heartbeat_estate.mjs --pull <node>=<ssh-target> --run-proposal collector-schedule — the merged board. Each node keeps its own chained log; the collector pulls and folds a view without joining the chains.

#### Estate heartbeat refusal 1

Estate heartbeat (Mission Control arc) refuses to do this: The ledger records transitions, not observations — an unchanged service writes nothing. Also called: health, uptime, estate board, node down.

#### Estate heartbeat refusal 2

Estate heartbeat (Mission Control arc) refuses to do this: A stale node is not good news, it is no news: it is carried as a blind spot, never dropped from the board. Also called: health, uptime, estate board, node down.

#### Estate heartbeat refusal 3

Estate heartbeat (Mission Control arc) refuses to do this: A failed pull must not make a node vanish — absence reading as health is the failure this exists to catch. Also called: health, uptime, estate board, node down.

### Inventory sweep

Inventory sweep (Mission Control arc). Look at the disk and hold the ledger to it — the outside view that makes two defects measurable. How to use it: node scripts/inventory_sweep.mjs — looks and reports; safe to run any time. Add --include <dir> to widen the boundary beyond the store's own roots. Add --record to store the snapshot in the CAS and append a sweep_recorded event.

#### Inventory sweep refusal 1

Inventory sweep (Mission Control arc) refuses to do this: Reconciliation is by PATH, not machine: a placement is judged only if its path was actually walked. Also called: sweep, reconcile, orphan, scripts/inventory_sweep.mjs.

#### Inventory sweep refusal 2

Inventory sweep (Mission Control arc) refuses to do this: An unreachable path is UNSEEN — neither present nor missing, and folded into neither verdict. Also called: sweep, reconcile, orphan, scripts/inventory_sweep.mjs.

#### Inventory sweep refusal 3

Inventory sweep (Mission Control arc) refuses to do this: The scope travels with the result: '0 orphans' means nothing without the boundary it was measured in. Also called: sweep, reconcile, orphan, scripts/inventory_sweep.mjs.

#### Inventory sweep refusal 4

Inventory sweep (Mission Control arc) refuses to do this: It refuses to reconcile against a ledger that does not verify. Also called: sweep, reconcile, orphan, scripts/inventory_sweep.mjs.

### Run register

Run register (Mission Control arc). Record every execution, authorised or not, so unauthorised ones can be found. How to use it: The artifact CLI records each acquire, place and evict automatically. The collector records each scheduled firing when given --run-proposal. The evidence pack folds all sources into one population and checks each claim.

#### Run register refusal 1

Run register (Mission Control arc) refuses to do this: A system that will not record an unauthorised run cannot detect one — proposal_id is recorded as claimed, including null. Also called: run register, execution, unauthorised run.

#### Run register refusal 2

Run register (Mission Control arc) refuses to do this: Verification happens at read time, never at write time. Also called: run register, execution, unauthorised run.

#### Run register refusal 3

Run register (Mission Control arc) refuses to do this: Outcome carries what actually happened; a register of successes only answers a different question. Also called: run register, execution, unauthorised run.

### Evidence pack

Evidence pack (Mission Control arc). One document a reviewer can read without a tour of the codebase, including what cannot be proved. How to use it: node scripts/evidence_pack.mjs — sweeps, folds and writes evidence-pack.md to the store. Read the verdict first, then the four closure defects with their populations. Exit code 0 only when every defect is measured, zero, AND had something to measure.

#### Evidence pack refusal 1

Evidence pack (Mission Control arc) refuses to do this: Three states per defect: clean, defects found, or NOT MEASURABLE. The third never masquerades as the first. Also called: audit, evidence, closure defect, scripts/evidence_pack.mjs.

#### Evidence pack refusal 2

Evidence pack (Mission Control arc) refuses to do this: A gauge with an empty population is named as vacuous — 0 of 0 and 0 of 200 are the same digit and different assurances. Also called: audit, evidence, closure defect, scripts/evidence_pack.mjs.

#### Evidence pack refusal 3

Evidence pack (Mission Control arc) refuses to do this: Pre-control runs are excluded and shown, because a run cannot be signed by a mechanism that did not exist when it ran. Also called: audit, evidence, closure defect, scripts/evidence_pack.mjs.

## Agent arc

The Agent arc exists to ask. It renders at #/agent.

### Agent Benny

Agent Benny (Agent arc). The guide who lives in the app: answers in the first person, raises proposals, and never signs. How to use it: Talk to Benny from the floating overlay, the tray, or the Agent arc. Ask about anything in this manual — it is loaded into his memory as retrievable chunks and graph facts. When he finds work worth doing he raises a proposal in the Gov arc for you to decide.

#### Agent Benny refusal 1

Agent Benny (Agent arc) refuses to do this: Benny narrates in the first person, short and warm, and never uses marketing voice inside the product. Also called: agent, assistant, dog, mascot.

#### Agent Benny refusal 2

Agent Benny (Agent arc) refuses to do this: He may propose and may never authorise (ADR-001). Also called: agent, assistant, dog, mascot.

#### Agent Benny refusal 3

Agent Benny (Agent arc) refuses to do this: Motion is feedback to what you did; his idle micro-states are the only sanctioned loop. Also called: agent, assistant, dog, mascot.

### Arc navigation

Arc navigation (Agent arc). The ring of arcs is the estate's map: each arc is a job, not a menu category. How to use it: Click an arc on the navi-key ring to open its panel. Gov decides, Lineage proves, Mission Control watches, Memory recalls. Lineage shares the Gov colour deliberately: it is the evidence side of the same arc.

#### Arc navigation refusal 1

Arc navigation (Agent arc) refuses to do this: One primary action per view, rust-accented; everything secondary sits behind a consistent More disclosure. Also called: navigation, ring, navi-key, panels.

#### Arc navigation refusal 2

Arc navigation (Agent arc) refuses to do this: No ambient motion — animation is feedback to a user action only. Also called: navigation, ring, navi-key, panels.

#### Arc navigation refusal 3

Arc navigation (Agent arc) refuses to do this: Every surface must be readable at 375px and in reduced-motion. Also called: navigation, ring, navi-key, panels.

## Files arc

The Files arc exists to hold. It renders at #/file_explorer.

### Download once, place anywhere

Download once, place anywhere (Files arc). One content-addressed copy of a file for the whole estate, placed on any machine that needs it. How to use it: node scripts/artifact.mjs acquire --source <url|path> --expected-hash <sha256> --caused-by proposal:<id> node scripts/artifact.mjs place --hash <sha256> --at <path> --purpose install --caused-by proposal:<id> node scripts/artifact.mjs ls — what is held and where every copy lives. node scripts/artifact.mjs evict --hash <sha256> --at <path> — retires the copy, keeps the blob.

#### Download once, place anywhere refusal 1

Download once, place anywhere (Files arc) refuses to do this: With expected-hash and the blob already held, the source is never opened — that is the saving, not de-dup after the fact. Also called: artifact CLI, scripts/artifact.mjs, acquire, place, evict, download, installer, NAS.

#### Download once, place anywhere refusal 2

Download once, place anywhere (Files arc) refuses to do this: A --caused-by naming a proposal must name one a human actually signed; unsigned, declined or missing is refused. Also called: artifact CLI, scripts/artifact.mjs, acquire, place, evict, download, installer, NAS.

#### Download once, place anywhere refusal 3

Download once, place anywhere (Files arc) refuses to do this: Omitting --caused-by stays legal and is recorded honestly as unprovenanced. Forcing it would teach you to type a plausible id. Also called: artifact CLI, scripts/artifact.mjs, acquire, place, evict, download, installer, NAS.

#### Download once, place anywhere refusal 4

Download once, place anywhere (Files arc) refuses to do this: Eviction retires a placement and never the blob: reclaiming space must not destroy the only copy. Also called: artifact CLI, scripts/artifact.mjs, acquire, place, evict, download, installer, NAS.

## Workflow: Onboard an application

Bring a new application into the estate so it is authorised, stored once, placed everywhere, and remembered.

### Onboard an application step 1: Propose

Onboard an application, step 1 of 6: Propose. Performed by agent or you. Raise a proposal naming the application, why it is wanted, what it costs and whether it reverses. Command: node scripts/app_onboard.mjs propose --app <id> --title <name> --source <url> --rationale <why>. Gate: Nothing is downloaded or installed at this step.

### Onboard an application step 2: Decide

Onboard an application, step 2 of 6: Decide. Performed by you, and only you. Open the Gov arc and sign or decline. This is the authorisation the rest of the workflow cites. Gate: The workflow refuses to continue while the proposal is open or declined.

### Onboard an application step 3: Acquire

Onboard an application, step 3 of 6: Acquire. Performed by estate. Fetch the bytes once into the content-addressed store, citing the signed proposal. Command: node scripts/app_onboard.mjs acquire --app <id>. Gate: If the hash is already held the source is never opened.

### Onboard an application step 4: Place

Onboard an application, step 4 of 6: Place. Performed by estate. Materialise a copy on each machine that needs it, recording a placement per node. Command: node scripts/app_onboard.mjs place --app <id> --at <path>. Gate: Each placement records the same signed proposal as its cause.

### Onboard an application step 5: Remember

Onboard an application, step 5 of 6: Remember. Performed by estate. Register the application as a feature, rebuild the manual, and reload the agent's memory and graph. Command: node scripts/manual_build.mjs. Gate: The build fails if the new entry references a file or surface that does not exist.

### Onboard an application step 6: Prove

Onboard an application, step 6 of 6: Prove. Performed by estate. Sweep and generate the evidence pack; the new artifact, its placements and its runs all appear with the signature behind them. Command: node scripts/evidence_pack.mjs. Gate: Exit 0 only if every defect is measured, zero and non-vacuous.

## Workflow: Prove the estate

Produce, from cold, the evidence that the estate is governed.

### Prove the estate step 1: Sweep

Prove the estate, step 1 of 4: Sweep. Performed by estate. Compare the disk with the ledger. Command: node scripts/inventory_sweep.mjs --record.

### Prove the estate step 2: Board

Prove the estate, step 2 of 4: Board. Performed by estate. Fold every node's heartbeat into one view. Command: node scripts/heartbeat_estate.mjs --run-proposal collector-schedule.

### Prove the estate step 3: Pack

Prove the estate, step 3 of 4: Pack. Performed by estate. Write the evidence pack with its verdict. Command: node scripts/evidence_pack.mjs.

### Prove the estate step 4: Read

Prove the estate, step 4 of 4: Read. Performed by you. Check the verdict names any vacuous gauge and any unseen scope before you believe it.

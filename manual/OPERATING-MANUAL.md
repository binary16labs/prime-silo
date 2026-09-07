# Prime-Silo Operating Manual

_What the estate does, how to work it, and what each part refuses to do_

## The four rules everything else follows

- Agents propose; humans sign. An agent may never authorise its own work (ADR-001, R38).
- The ledger records what happened, including what happened badly. A register holding only successes answers a different question than the one asked.
- Absence is a finding, not a pass. 'Not measurable', 'unseen' and 'nothing to measure' each get their own words and are never dressed as clean.
- Provenance is declared, never inferred. A guessed edge is indistinguishable from a real one, which defeats the audit.

## The arcs

| Arc | Job | Surface |
| --- | --- | --- |
| Gov | Decide | `#/_prime_silo/gov` |
| Lineage | Prove | `#/_prime_silo/lineage` |
| Mission Control | Watch | `#/_prime_silo/mission_control` |
| Memory | Recall | `#/_prime_silo/memory` |
| Lifelog | Recall | `#/_prime_silo/lifelog` |
| Step-Through | Replay | `#/_prime_silo/step_through` |
| Agent | Ask | `#/agent` |
| Files | Hold | `#/file_explorer` |
| Local LLM | Think | `#/huggingface` |
| The Deck | Watch | `#/_prime_silo/deck` |

## Features

### The event ledger

**Lineage arc** — Every fact the estate knows is an append-only, hash-chained event with two timestamps and an author.

**How**

- Each ledger is one file under <estate-store>/eventlog/, and each is its own hash chain.
- Chains are never concatenated — joining two logs breaks every prev hash from the join onward.
- Read state by folding events, never by trusting a cached projection.

**What it refuses to do**

- authorship is exactly human | frontier | house — nothing else is valid.
- valid_time is when a thing was true; txn_time is when we learned it; time_confidence says which of those was measured.
- A broken chain quarantines its own ledger and no others.

Source: `server/coordination/lib/kel.mjs`, `server/coordination/schema/kel-event.schema.json`

### Raise a proposal

**Gov arc** — Put work forward for a decision. This is where every causal chain in the estate begins.

**How**

- POST /api/gov_raise with proposalId, title, rationale, and optionally derivedFrom.
- Re-raising with identical content writes nothing; changed content refreshes the open proposal in place.
- A settled proposal cannot be re-raised — choose a new id if the situation genuinely changed.

**What it refuses to do**

- authorship is hard-coded frontier: a request is a program, never a person. Who asked is kept separately as requested_by.
- A proposal without a rationale is refused — the signer decides on the why, not the title.
- derivedFrom must be subject ids, never prose; a reason is not a reference.

API: `POST /api/gov_raise`

Source: `server/api/gov_raise.js`, `server/coordination/lib/governance.mjs`

### Sign or decline

**Gov arc** — The one place authorisation is granted in the whole estate.

**How**

- Open the Gov arc. Each card shows why, what it rests on, what it costs and whether it reverses — all before the buttons.
- Sign is the single primary action. Decline sits beside it, quiet but recorded.
- Evidence is a disclosure, not a third competing button.

**What it refuses to do**

- The client cannot choose the signer — identity comes from the session, and a signer in the request body is ignored.
- Only a human signs: authorship is hard-coded, not a parameter.
- Declines are kept. A register of approvals only would imply everything proposed was accepted.
- Signing is refused onto a ledger whose chain does not verify.

API: `GET /api/gov_proposals` · `POST /api/gov_sign`

Source: `server/api/gov_sign.js`, `app/L0/_all/mod/_prime_silo/gov/view.html`

### Total lineage

**Lineage arc** — Every subject the estate has recorded, folded from every ledger, with an honest measure of what is missing.

**How**

- Open the Lineage arc. Coverage comes before the rows on purpose.
- Four figures: ledgers verified, subjects attested, origin recorded, and ledger-vs-world.
- Filter by kind, then pick a subject to walk its history.

**What it refuses to do**

- A subject from a failing ledger is shown but never counted as evidence.
- Edges exist only where an event declares derived_from or caused_by. Nothing is inferred.
- Ledger-to-world completeness is NOT MEASURABLE without an inventory sweep, and says so.

API: `GET /api/lineage_index` · `GET /api/lineage_trail`

Source: `server/coordination/lib/lineage.mjs`, `app/L0/_all/mod/_prime_silo/lineage/view.html`

### Step through a subject's history

**Lineage arc** — Replay any subject one event at a time, seeing what the system believed at each step.

**How**

- Select a subject in the Lineage arc; it opens on the most recent event.
- Prev / Next walk the trail, or press the left and right arrow keys.
- The tick rail colours each event by who caused it — human, frontier or house.

**What it refuses to do**

- The projection at each step is computed with the system's own projector, so a replay can never drift from live state.
- That projector is last-write-wins per subject, not accumulating — the field is called projection, not state, and the page says so.
- The event's own payload is always shown in full and is never lossy.

API: `GET /api/lineage_trail`

Source: `server/api/lineage_trail.js`, `app/L0/_all/mod/_prime_silo/lineage/lineage.js`

### Download once, place anywhere

**Files arc** — One content-addressed copy of a file for the whole estate, placed on any machine that needs it.

**How**

- node scripts/artifact.mjs acquire --source <url|path> --expected-hash <sha256> --caused-by proposal:<id>
- node scripts/artifact.mjs place --hash <sha256> --at <path> --purpose install --caused-by proposal:<id>
- node scripts/artifact.mjs ls — what is held and where every copy lives.
- node scripts/artifact.mjs evict --hash <sha256> --at <path> — retires the copy, keeps the blob.

**What it refuses to do**

- With expected-hash and the blob already held, the source is never opened — that is the saving, not de-dup after the fact.
- A --caused-by naming a proposal must name one a human actually signed; unsigned, declined or missing is refused.
- Omitting --caused-by stays legal and is recorded honestly as unprovenanced. Forcing it would teach you to type a plausible id.
- Eviction retires a placement and never the blob: reclaiming space must not destroy the only copy.

Source: `scripts/artifact.mjs`, `server/coordination/lib/artifacts.mjs`

### Where a thing came from

**Lineage arc** — Two payload fields carry the estate's whole genealogy: derived_from and caused_by.

**How**

- Pass --derived-from / --caused-by to the artifact CLI, or derivedFrom / causedBy to the raise API.
- derived_from is a list (a thing may be made from many); caused_by is single (one decision brought it about).
- Read the result as ORIGIN RECORDED in the Lineage arc.

**What it refuses to do**

- An edge must be a subject id, never prose — a reason written as a reference becomes a dangling parent forever.
- Nothing is its own ancestor.
- Absent is not empty: with no provenance the keys are omitted, because [] would assert 'derived from nothing'.

Source: `server/coordination/lib/provenance.mjs`

### Estate heartbeat

**Mission Control arc** — Know which machines and services are alive, and notice silence rather than assuming health.

**How**

- node scripts/heartbeat_run.mjs --machine <name> — one node's sweep, scheduled every 5 minutes.
- node scripts/heartbeat_estate.mjs --pull <node>=<ssh-target> --run-proposal collector-schedule — the merged board.
- Each node keeps its own chained log; the collector pulls and folds a view without joining the chains.

**What it refuses to do**

- The ledger records transitions, not observations — an unchanged service writes nothing.
- A stale node is not good news, it is no news: it is carried as a blind spot, never dropped from the board.
- A failed pull must not make a node vanish — absence reading as health is the failure this exists to catch.

Source: `server/coordination/lib/heartbeat.mjs`, `scripts/heartbeat_estate.mjs`

### Inventory sweep

**Mission Control arc** — Look at the disk and hold the ledger to it — the outside view that makes two defects measurable.

**How**

- node scripts/inventory_sweep.mjs — looks and reports; safe to run any time.
- Add --include <dir> to widen the boundary beyond the store's own roots.
- Add --record to store the snapshot in the CAS and append a sweep_recorded event.

**What it refuses to do**

- Reconciliation is by PATH, not machine: a placement is judged only if its path was actually walked.
- An unreachable path is UNSEEN — neither present nor missing, and folded into neither verdict.
- The scope travels with the result: '0 orphans' means nothing without the boundary it was measured in.
- It refuses to reconcile against a ledger that does not verify.

Source: `server/coordination/lib/inventory.mjs`, `scripts/inventory_sweep.mjs`

### Run register

**Mission Control arc** — Record every execution, authorised or not, so unauthorised ones can be found.

**How**

- The artifact CLI records each acquire, place and evict automatically.
- The collector records each scheduled firing when given --run-proposal.
- The evidence pack folds all sources into one population and checks each claim.

**What it refuses to do**

- A system that will not record an unauthorised run cannot detect one — proposal_id is recorded as claimed, including null.
- Verification happens at read time, never at write time.
- Outcome carries what actually happened; a register of successes only answers a different question.

Source: `server/coordination/lib/runs.mjs`

### Evidence pack

**Mission Control arc** — One document a reviewer can read without a tour of the codebase, including what cannot be proved.

**How**

- node scripts/evidence_pack.mjs — sweeps, folds and writes evidence-pack.md to the store.
- Read the verdict first, then the four closure defects with their populations.
- Exit code 0 only when every defect is measured, zero, AND had something to measure.

**What it refuses to do**

- Three states per defect: clean, defects found, or NOT MEASURABLE. The third never masquerades as the first.
- A gauge with an empty population is named as vacuous — 0 of 0 and 0 of 200 are the same digit and different assurances.
- Pre-control runs are excluded and shown, because a run cannot be signed by a mechanism that did not exist when it ran.

Source: `server/coordination/lib/evidence.mjs`, `scripts/evidence_pack.mjs`

### Agent Benny

**Agent arc** — The guide who lives in the app: answers in the first person, raises proposals, and never signs.

**How**

- Talk to Benny from the floating overlay, the tray, or the Agent arc.
- Ask about anything in this manual — it is loaded into his memory as retrievable chunks and graph facts.
- When he finds work worth doing he raises a proposal in the Gov arc for you to decide.

**What it refuses to do**

- Benny narrates in the first person, short and warm, and never uses marketing voice inside the product.
- He may propose and may never authorise (ADR-001).
- Motion is feedback to what you did; his idle micro-states are the only sanctioned loop.

Source: `app/L0/_all/mod/_prime_silo/gov/gov.js`

### Arc navigation

**Agent arc** — The ring of arcs is the estate's map: each arc is a job, not a menu category.

**How**

- Click an arc on the navi-key ring to open its panel.
- Gov decides, Lineage proves, Mission Control watches, Memory recalls.
- Lineage shares the Gov colour deliberately: it is the evidence side of the same arc.

**What it refuses to do**

- One primary action per view, rust-accented; everything secondary sits behind a consistent More disclosure.
- No ambient motion — animation is feedback to a user action only.
- Every surface must be readable at 375px and in reduced-motion.

Source: `app/L0/_all/mod/_core/visual/navi/navi-key.js`

### The estate on a wall

**The Deck arc** — One glanceable surface answering four questions at once — what is waiting on you, what is proven, which machines are reporting, and what ran without authorisation — sized for a projector, a monitor, or a phone.

**How**

- Open it inside the app at #/_prime_silo/deck, or full screen at /deck for a projector or a spare monitor.
- Every figure is folded from the ledgers in one request, so the four tiles are always the same moment of the estate.
- Three tiers pick themselves from the width of the surface: wall, column and pocket. Nothing is configured.
- Room mode hides machine names, proposal titles and store paths for a screen other people can see.

**What it refuses to do**

- Absence is a state, not a zero — a deck that cannot see the ledgers says 'not reporting' instead of showing green.
- A count is always shown with the population it came from: 2/113, never 2.
- Motion is feedback to a real change in the numbers; nothing on the deck moves on a timer.

Source: `server/api/deck_state.js`, `app/L0/_all/mod/_prime_silo/deck/deck.js`, `server/pages/deck.html`

### Talking to the deck

**The Deck arc** — Ask the estate a question out loud from across the room, and hear the answer back — navigate, query and raise a proposal, but never sign one.

**How**

- Hold the talk button while you speak and release to send; the deck never listens on its own.
- Benny transcribes what was said, the router decides what it meant, and the deck goes to that surface.
- The reply appears as text first and is then spoken through Voicebox, so a silent mouth costs you nothing but the sound.
- Start Benny on :8005 to be heard and Voicebox on :17493 to be answered aloud; the deck reports which of the two is missing.

**What it refuses to do**

- The voice router has no branch that can sign. A spoken 'sign it' is refused and the queue is opened instead.
- The microphone is push-to-talk. There is no always-listening mode and no wake word.
- Hearing and speaking are separate capabilities: with Voicebox down the microphone still works and replies stay in text.

Source: `server/lib/deck_intents.js`, `server/api/deck_voice.js`, `server/api/deck_speak.js`, `tests/deck_intents_test.mjs`

### The estate on paper

**The Deck arc** — The same board rendered as a finished page with no script, no stylesheet request and nothing to hydrate — for a Kindle, an e-ink frame, or any browser too old or too limited for the app.

**How**

- Point the device at /api/deck_kindle and bookmark it; add ?room=1 to hide names and titles.
- It renders from the deck's own fold, so the paper board and the wall cannot disagree.
- The page refreshes itself every five minutes and prints the time it was read.

**What it refuses to do**

- No script tag, no external stylesheet, no image — the tier exists for devices where those fail.
- State is carried by words and by inversion, never by colour, because e-ink has none.
- The reading time is always on the page: an old picture that says how old it is is still evidence.

Source: `server/api/deck_kindle.js`, `tests/deck_kindle_test.mjs`

## Workflows

### Onboard an application

Bring a new application into the estate so it is authorised, stored once, placed everywhere, and remembered.

**1. Propose** — _agent or you_

Raise a proposal naming the application, why it is wanted, what it costs and whether it reverses.

```bash
node scripts/app_onboard.mjs propose --app <id> --title <name> --source <url> --rationale <why>
```

> Nothing is downloaded or installed at this step.

**2. Decide** — _you, and only you_

Open the Gov arc and sign or decline. This is the authorisation the rest of the workflow cites.

> The workflow refuses to continue while the proposal is open or declined.

**3. Acquire** — _estate_

Fetch the bytes once into the content-addressed store, citing the signed proposal.

```bash
node scripts/app_onboard.mjs acquire --app <id>
```

> If the hash is already held the source is never opened.

**4. Place** — _estate_

Materialise a copy on each machine that needs it, recording a placement per node.

```bash
node scripts/app_onboard.mjs place --app <id> --at <path>
```

> Each placement records the same signed proposal as its cause.

**5. Remember** — _estate_

Register the application as a feature, rebuild the manual, and reload the agent's memory and graph.

```bash
node scripts/manual_build.mjs
```

> The build fails if the new entry references a file or surface that does not exist.

**6. Prove** — _estate_

Sweep and generate the evidence pack; the new artifact, its placements and its runs all appear with the signature behind them.

```bash
node scripts/evidence_pack.mjs
```

> Exit 0 only if every defect is measured, zero and non-vacuous.

### Prove the estate

Produce, from cold, the evidence that the estate is governed.

**1. Sweep** — _estate_

Compare the disk with the ledger.

```bash
node scripts/inventory_sweep.mjs --record
```

**2. Board** — _estate_

Fold every node's heartbeat into one view.

```bash
node scripts/heartbeat_estate.mjs --run-proposal collector-schedule
```

**3. Pack** — _estate_

Write the evidence pack with its verdict.

```bash
node scripts/evidence_pack.mjs
```

**4. Read** — _you_

Check the verdict names any vacuous gauge and any unseen scope before you believe it.


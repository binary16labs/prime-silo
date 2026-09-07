Prime-Silo Operating Manual — retrieval text.

The event ledger. The event ledger (Lineage arc). Every fact the estate knows is an append-only, hash-chained event with two timestamps and an author. How to use it: Each ledger is one file under <estate-store>/eventlog/, and each is its own hash chain. Chains are never concatenated — joining two logs breaks every prev hash from the join onward. Read state by folding events, never by trusting a cached projection. (KEL, event log, eventlog, ledger, hash chain)

The event ledger — refusal 1. The event ledger — Lineage arc. authorship is exactly human | frontier | house — nothing else is valid. (KEL, event log, eventlog, ledger, hash chain)

The event ledger — refusal 2. The event ledger — Lineage arc. valid_time is when a thing was true; txn_time is when we learned it; time_confidence says which of those was measured. (KEL, event log, eventlog, ledger, hash chain)

The event ledger — refusal 3. The event ledger — Lineage arc. A broken chain quarantines its own ledger and no others. (KEL, event log, eventlog, ledger, hash chain)

Raise a proposal. Raise a proposal (Gov arc). Put work forward for a decision. This is where every causal chain in the estate begins. How to use it: POST /api/gov_raise with proposalId, title, rationale, and optionally derivedFrom. Re-raising with identical content writes nothing; changed content refreshes the open proposal in place. A settled proposal cannot be re-raised — choose a new id if the situation genuinely changed. API: POST /api/gov_raise. (propose, proposal, raise)

Raise a proposal — refusal 1. Raise a proposal — Gov arc. authorship is hard-coded frontier: a request is a program, never a person. Who asked is kept separately as requested_by. (propose, proposal, raise)

Raise a proposal — refusal 2. Raise a proposal — Gov arc. A proposal without a rationale is refused — the signer decides on the why, not the title. (propose, proposal, raise)

Raise a proposal — refusal 3. Raise a proposal — Gov arc. derivedFrom must be subject ids, never prose; a reason is not a reference. (propose, proposal, raise)

Sign or decline. Sign or decline (Gov arc). The one place authorisation is granted in the whole estate. How to use it: Open the Gov arc. Each card shows why, what it rests on, what it costs and whether it reverses — all before the buttons. Sign is the single primary action. Decline sits beside it, quiet but recorded. Evidence is a disclosure, not a third competing button. API: GET /api/gov_proposals, POST /api/gov_sign. (signature, authorise, approve, sign off, Gov arc)

Sign or decline — refusal 1. Sign or decline — Gov arc. The client cannot choose the signer — identity comes from the session, and a signer in the request body is ignored. (signature, authorise, approve, sign off, Gov arc)

Sign or decline — refusal 2. Sign or decline — Gov arc. Only a human signs: authorship is hard-coded, not a parameter. (signature, authorise, approve, sign off, Gov arc)

Sign or decline — refusal 3. Sign or decline — Gov arc. Declines are kept. A register of approvals only would imply everything proposed was accepted. (signature, authorise, approve, sign off, Gov arc)

Sign or decline — refusal 4. Sign or decline — Gov arc. Signing is refused onto a ledger whose chain does not verify. (signature, authorise, approve, sign off, Gov arc)

Total lineage. Total lineage (Lineage arc). Every subject the estate has recorded, folded from every ledger, with an honest measure of what is missing. How to use it: Open the Lineage arc. Coverage comes before the rows on purpose. Four figures: ledgers verified, subjects attested, origin recorded, and ledger-vs-world. Filter by kind, then pick a subject to walk its history. API: GET /api/lineage_index, GET /api/lineage_trail. (provenance, audit trail, where did this come from)

Total lineage — refusal 1. Total lineage — Lineage arc. A subject from a failing ledger is shown but never counted as evidence. (provenance, audit trail, where did this come from)

Total lineage — refusal 2. Total lineage — Lineage arc. Edges exist only where an event declares derived_from or caused_by. Nothing is inferred. (provenance, audit trail, where did this come from)

Total lineage — refusal 3. Total lineage — Lineage arc. Ledger-to-world completeness is NOT MEASURABLE without an inventory sweep, and says so. (provenance, audit trail, where did this come from)

Step through a subject's history. Step through a subject's history (Lineage arc). Replay any subject one event at a time, seeing what the system believed at each step. How to use it: Select a subject in the Lineage arc; it opens on the most recent event. Prev / Next walk the trail, or press the left and right arrow keys. The tick rail colours each event by who caused it — human, frontier or house. API: GET /api/lineage_trail. (replay, step through, history, time travel)

Step through a subject's history — refusal 1. Step through a subject's history — Lineage arc. The projection at each step is computed with the system's own projector, so a replay can never drift from live state. (replay, step through, history, time travel)

Step through a subject's history — refusal 2. Step through a subject's history — Lineage arc. That projector is last-write-wins per subject, not accumulating — the field is called projection, not state, and the page says so. (replay, step through, history, time travel)

Step through a subject's history — refusal 3. Step through a subject's history — Lineage arc. The event's own payload is always shown in full and is never lossy. (replay, step through, history, time travel)

Download once, place anywhere. Download once, place anywhere (Files arc). One content-addressed copy of a file for the whole estate, placed on any machine that needs it. How to use it: node scripts/artifact.mjs acquire --source <url|path> --expected-hash <sha256> --caused-by proposal:<id> node scripts/artifact.mjs place --hash <sha256> --at <path> --purpose install --caused-by proposal:<id> node scripts/artifact.mjs ls — what is held and where every copy lives. node scripts/artifact.mjs evict --hash <sha256> --at <path> — retires the copy, keeps the blob. (artifact CLI, scripts/artifact.mjs, acquire, place, evict, download, installer, NAS)

Download once, place anywhere — refusal 1. Download once, place anywhere — Files arc. With expected-hash and the blob already held, the source is never opened — that is the saving, not de-dup after the fact. (artifact CLI, scripts/artifact.mjs, acquire, place, evict, download, installer, NAS)

Download once, place anywhere — refusal 2. Download once, place anywhere — Files arc. A --caused-by naming a proposal must name one a human actually signed; unsigned, declined or missing is refused. (artifact CLI, scripts/artifact.mjs, acquire, place, evict, download, installer, NAS)

Download once, place anywhere — refusal 3. Download once, place anywhere — Files arc. Omitting --caused-by stays legal and is recorded honestly as unprovenanced. Forcing it would teach you to type a plausible id. (artifact CLI, scripts/artifact.mjs, acquire, place, evict, download, installer, NAS)

Download once, place anywhere — refusal 4. Download once, place anywhere — Files arc. Eviction retires a placement and never the blob: reclaiming space must not destroy the only copy. (artifact CLI, scripts/artifact.mjs, acquire, place, evict, download, installer, NAS)

Where a thing came from. Where a thing came from (Lineage arc). Two payload fields carry the estate's whole genealogy: derived_from and caused_by. How to use it: Pass --derived-from / --caused-by to the artifact CLI, or derivedFrom / causedBy to the raise API. derived_from is a list (a thing may be made from many); caused_by is single (one decision brought it about). Read the result as ORIGIN RECORDED in the Lineage arc. (derived_from, caused_by, origin)

Where a thing came from — refusal 1. Where a thing came from — Lineage arc. An edge must be a subject id, never prose — a reason written as a reference becomes a dangling parent forever. (derived_from, caused_by, origin)

Where a thing came from — refusal 2. Where a thing came from — Lineage arc. Nothing is its own ancestor. (derived_from, caused_by, origin)

Where a thing came from — refusal 3. Where a thing came from — Lineage arc. Absent is not empty: with no provenance the keys are omitted, because [] would assert 'derived from nothing'. (derived_from, caused_by, origin)

Estate heartbeat. Estate heartbeat (Mission Control arc). Know which machines and services are alive, and notice silence rather than assuming health. How to use it: node scripts/heartbeat_run.mjs --machine <name> — one node's sweep, scheduled every 5 minutes. node scripts/heartbeat_estate.mjs --pull <node>=<ssh-target> --run-proposal collector-schedule — the merged board. Each node keeps its own chained log; the collector pulls and folds a view without joining the chains. (health, uptime, estate board, node down)

Estate heartbeat — refusal 1. Estate heartbeat — Mission Control arc. The ledger records transitions, not observations — an unchanged service writes nothing. (health, uptime, estate board, node down)

Estate heartbeat — refusal 2. Estate heartbeat — Mission Control arc. A stale node is not good news, it is no news: it is carried as a blind spot, never dropped from the board. (health, uptime, estate board, node down)

Estate heartbeat — refusal 3. Estate heartbeat — Mission Control arc. A failed pull must not make a node vanish — absence reading as health is the failure this exists to catch. (health, uptime, estate board, node down)

Inventory sweep. Inventory sweep (Mission Control arc). Look at the disk and hold the ledger to it — the outside view that makes two defects measurable. How to use it: node scripts/inventory_sweep.mjs — looks and reports; safe to run any time. Add --include <dir> to widen the boundary beyond the store's own roots. Add --record to store the snapshot in the CAS and append a sweep_recorded event. (sweep, reconcile, orphan, scripts/inventory_sweep.mjs)

Inventory sweep — refusal 1. Inventory sweep — Mission Control arc. Reconciliation is by PATH, not machine: a placement is judged only if its path was actually walked. (sweep, reconcile, orphan, scripts/inventory_sweep.mjs)

Inventory sweep — refusal 2. Inventory sweep — Mission Control arc. An unreachable path is UNSEEN — neither present nor missing, and folded into neither verdict. (sweep, reconcile, orphan, scripts/inventory_sweep.mjs)

Inventory sweep — refusal 3. Inventory sweep — Mission Control arc. The scope travels with the result: '0 orphans' means nothing without the boundary it was measured in. (sweep, reconcile, orphan, scripts/inventory_sweep.mjs)

Inventory sweep — refusal 4. Inventory sweep — Mission Control arc. It refuses to reconcile against a ledger that does not verify. (sweep, reconcile, orphan, scripts/inventory_sweep.mjs)

Run register. Run register (Mission Control arc). Record every execution, authorised or not, so unauthorised ones can be found. How to use it: The artifact CLI records each acquire, place and evict automatically. The collector records each scheduled firing when given --run-proposal. The evidence pack folds all sources into one population and checks each claim. (run register, execution, unauthorised run)

Run register — refusal 1. Run register — Mission Control arc. A system that will not record an unauthorised run cannot detect one — proposal_id is recorded as claimed, including null. (run register, execution, unauthorised run)

Run register — refusal 2. Run register — Mission Control arc. Verification happens at read time, never at write time. (run register, execution, unauthorised run)

Run register — refusal 3. Run register — Mission Control arc. Outcome carries what actually happened; a register of successes only answers a different question. (run register, execution, unauthorised run)

Evidence pack. Evidence pack (Mission Control arc). One document a reviewer can read without a tour of the codebase, including what cannot be proved. How to use it: node scripts/evidence_pack.mjs — sweeps, folds and writes evidence-pack.md to the store. Read the verdict first, then the four closure defects with their populations. Exit code 0 only when every defect is measured, zero, AND had something to measure. (audit, evidence, closure defect, scripts/evidence_pack.mjs)

Evidence pack — refusal 1. Evidence pack — Mission Control arc. Three states per defect: clean, defects found, or NOT MEASURABLE. The third never masquerades as the first. (audit, evidence, closure defect, scripts/evidence_pack.mjs)

Evidence pack — refusal 2. Evidence pack — Mission Control arc. A gauge with an empty population is named as vacuous — 0 of 0 and 0 of 200 are the same digit and different assurances. (audit, evidence, closure defect, scripts/evidence_pack.mjs)

Evidence pack — refusal 3. Evidence pack — Mission Control arc. Pre-control runs are excluded and shown, because a run cannot be signed by a mechanism that did not exist when it ran. (audit, evidence, closure defect, scripts/evidence_pack.mjs)

Agent Benny. Agent Benny (Agent arc). The guide who lives in the app: answers in the first person, raises proposals, and never signs. How to use it: Talk to Benny from the floating overlay, the tray, or the Agent arc. Ask about anything in this manual — it is loaded into his memory as retrievable chunks and graph facts. When he finds work worth doing he raises a proposal in the Gov arc for you to decide. (agent, assistant, dog, mascot)

Agent Benny — refusal 1. Agent Benny — Agent arc. Benny narrates in the first person, short and warm, and never uses marketing voice inside the product. (agent, assistant, dog, mascot)

Agent Benny — refusal 2. Agent Benny — Agent arc. He may propose and may never authorise (ADR-001). (agent, assistant, dog, mascot)

Agent Benny — refusal 3. Agent Benny — Agent arc. Motion is feedback to what you did; his idle micro-states are the only sanctioned loop. (agent, assistant, dog, mascot)

Arc navigation. Arc navigation (Agent arc). The ring of arcs is the estate's map: each arc is a job, not a menu category. How to use it: Click an arc on the navi-key ring to open its panel. Gov decides, Lineage proves, Mission Control watches, Memory recalls. Lineage shares the Gov colour deliberately: it is the evidence side of the same arc. (navigation, ring, navi-key, panels)

Arc navigation — refusal 1. Arc navigation — Agent arc. One primary action per view, rust-accented; everything secondary sits behind a consistent More disclosure. (navigation, ring, navi-key, panels)

Arc navigation — refusal 2. Arc navigation — Agent arc. No ambient motion — animation is feedback to a user action only. (navigation, ring, navi-key, panels)

Arc navigation — refusal 3. Arc navigation — Agent arc. Every surface must be readable at 375px and in reduced-motion. (navigation, ring, navi-key, panels)

The estate on a wall. The estate on a wall (The Deck arc). One glanceable surface answering four questions at once — what is waiting on you, what is proven, which machines are reporting, and what ran without authorisation — sized for a projector, a monitor, or a phone. How to use it: Open it inside the app at #/_prime_silo/deck, or full screen at /deck for a projector or a spare monitor. Every figure is folded from the ledgers in one request, so the four tiles are always the same moment of the estate. Three tiers pick themselves from the width of the surface: wall, column and pocket. Nothing is configured. Room mode hides machine names, proposal titles and store paths for a screen other people can see. (deck, HUD, HUD deck, wall, holodeck, dashboard on the wall, projector view)

The estate on a wall — refusal 1. The estate on a wall — The Deck arc. Absence is a state, not a zero — a deck that cannot see the ledgers says 'not reporting' instead of showing green. (deck, HUD, HUD deck, wall, holodeck, dashboard on the wall, projector view)

The estate on a wall — refusal 2. The estate on a wall — The Deck arc. A count is always shown with the population it came from: 2/113, never 2. (deck, HUD, HUD deck, wall, holodeck, dashboard on the wall, projector view)

The estate on a wall — refusal 3. The estate on a wall — The Deck arc. Motion is feedback to a real change in the numbers; nothing on the deck moves on a timer. (deck, HUD, HUD deck, wall, holodeck, dashboard on the wall, projector view)

Talking to the deck. Talking to the deck (The Deck arc). Ask the estate a question out loud from across the room, and hear the answer back — navigate, query and raise a proposal, but never sign one. How to use it: Hold the talk button while you speak and release to send; the deck never listens on its own. Benny transcribes what was said, the router decides what it meant, and the deck goes to that surface. The reply appears as text first and is then spoken through Voicebox, so a silent mouth costs you nothing but the sound. Start Benny on :8005 to be heard and Voicebox on :17493 to be answered aloud; the deck reports which of the two is missing. (voice, speech, talk to the estate, push to talk, STT, TTS, Voicebox, spoken commands)

Talking to the deck — refusal 1. Talking to the deck — The Deck arc. The voice router has no branch that can sign. A spoken 'sign it' is refused and the queue is opened instead. (voice, speech, talk to the estate, push to talk, STT, TTS, Voicebox, spoken commands)

Talking to the deck — refusal 2. Talking to the deck — The Deck arc. The microphone is push-to-talk. There is no always-listening mode and no wake word. (voice, speech, talk to the estate, push to talk, STT, TTS, Voicebox, spoken commands)

Talking to the deck — refusal 3. Talking to the deck — The Deck arc. Hearing and speaking are separate capabilities: with Voicebox down the microphone still works and replies stay in text. (voice, speech, talk to the estate, push to talk, STT, TTS, Voicebox, spoken commands)

The estate on paper. The estate on paper (The Deck arc). The same board rendered as a finished page with no script, no stylesheet request and nothing to hydrate — for a Kindle, an e-ink frame, or any browser too old or too limited for the app. How to use it: Point the device at /api/deck_kindle and bookmark it; add ?room=1 to hide names and titles. It renders from the deck's own fold, so the paper board and the wall cannot disagree. The page refreshes itself every five minutes and prints the time it was read. (Kindle, e-ink, paper, no-JS, static board, Kindle tier)

The estate on paper — refusal 1. The estate on paper — The Deck arc. No script tag, no external stylesheet, no image — the tier exists for devices where those fail. (Kindle, e-ink, paper, no-JS, static board, Kindle tier)

The estate on paper — refusal 2. The estate on paper — The Deck arc. State is carried by words and by inversion, never by colour, because e-ink has none. (Kindle, e-ink, paper, no-JS, static board, Kindle tier)

The estate on paper — refusal 3. The estate on paper — The Deck arc. The reading time is always on the page: an old picture that says how old it is is still evidence. (Kindle, e-ink, paper, no-JS, static board, Kindle tier)

Onboard an application — Propose. Onboard an application, step 1 of 6: Propose. Performed by agent or you. Raise a proposal naming the application, why it is wanted, what it costs and whether it reverses. Command: node scripts/app_onboard.mjs propose --app <id> --title <name> --source <url> --rationale <why>. Gate: Nothing is downloaded or installed at this step.

Onboard an application — Decide. Onboard an application, step 2 of 6: Decide. Performed by you, and only you. Open the Gov arc and sign or decline. This is the authorisation the rest of the workflow cites. Gate: The workflow refuses to continue while the proposal is open or declined.

Onboard an application — Acquire. Onboard an application, step 3 of 6: Acquire. Performed by estate. Fetch the bytes once into the content-addressed store, citing the signed proposal. Command: node scripts/app_onboard.mjs acquire --app <id>. Gate: If the hash is already held the source is never opened.

Onboard an application — Place. Onboard an application, step 4 of 6: Place. Performed by estate. Materialise a copy on each machine that needs it, recording a placement per node. Command: node scripts/app_onboard.mjs place --app <id> --at <path>. Gate: Each placement records the same signed proposal as its cause.

Onboard an application — Remember. Onboard an application, step 5 of 6: Remember. Performed by estate. Register the application as a feature, rebuild the manual, and reload the agent's memory and graph. Command: node scripts/manual_build.mjs. Gate: The build fails if the new entry references a file or surface that does not exist.

Onboard an application — Prove. Onboard an application, step 6 of 6: Prove. Performed by estate. Sweep and generate the evidence pack; the new artifact, its placements and its runs all appear with the signature behind them. Command: node scripts/evidence_pack.mjs. Gate: Exit 0 only if every defect is measured, zero and non-vacuous.

Prove the estate — Sweep. Prove the estate, step 1 of 4: Sweep. Performed by estate. Compare the disk with the ledger. Command: node scripts/inventory_sweep.mjs --record.

Prove the estate — Board. Prove the estate, step 2 of 4: Board. Performed by estate. Fold every node's heartbeat into one view. Command: node scripts/heartbeat_estate.mjs --run-proposal collector-schedule.

Prove the estate — Pack. Prove the estate, step 3 of 4: Pack. Performed by estate. Write the evidence pack with its verdict. Command: node scripts/evidence_pack.mjs.

Prove the estate — Read. Prove the estate, step 4 of 4: Read. Performed by you. Check the verdict names any vacuous gauge and any unseen scope before you believe it.

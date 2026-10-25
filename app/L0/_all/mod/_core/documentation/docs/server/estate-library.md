# Estate Library

The drive catalogue the librarian keeps, and the routes that answer questions of it. S21 built the
catalogue and the panel's view of it; S22 added the three questions an agent asks.

## Primary Sources

- `server/coordination/lib/library.mjs`
- `server/coordination/lib/estate_api.mjs`
- `delivery/tasks/S21.md`, `delivery/tasks/S22.md`

## Routes

All under `/api/estate/library`. Every one answers **this machine only** and needs a quarantine
policy, because the catalogue names files.

| Route                                            | Answers                                                                                                           |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| `GET /library`                                   | each root's last pass, totals by kind, and the top duplicate sets                                                 |
| `POST /library` `{root}`                         | start or resume a pass (202), or 409 if one is running                                                            |
| `POST /library/stop`                             | stop the running pass, keeping what it committed                                                                  |
| `GET /library.csv?root=`                         | every duplicate set as CSV, streamed from the worker's own list                                                   |
| `GET /library/find?root=&q=&kind=&limit=`        | files whose path contains `q`, with `withheld` counting private matches and `total` the matches before the limit  |
| `GET /library/duplicates?root=&offset=&limit=`   | sets beyond the panel's top ten, most wasted first, read from the worker's list                                   |
| `GET /library/folder?root=&path=&offset=&limit=` | one folder: its own figures, its immediate subfolders with theirs, the files directly in it, and the breadcrumb   |
| `GET /library/neighbours?root=&path=`            | which folders hold the other copies of this folder's content                                                      |
| `POST /library/check` `{path, root}`             | is this file, or every file under this folder, already on the drive: `on-root` with where, `changed`, or `absent` |

## The three guards

1. **Loopback only.** A non-local request gets 403. The catalogue holds file names.
2. **A policy must exist.** No quarantine policy means 412, never an unfiltered answer: a library
   that invents an empty policy is a guard that is never on.
3. **The store is configured, not assumed.** `ESTATE_STORE` is a declared parameter
   (`commands/params.yaml`), resolved through `runtime_params` and passed by `server/app.js`. Empty
   gives 503 and the sentence that fixes it — `node space set ESTATE_STORE=<folder>` — because a
   machine path shipped as a default is wrong on every machine but one.

## The privacy rule

Private paths are **counted, never named**, and the judgement happens in the hub for every caller —
the panel, the in-app `librarian` skill and the `library_*` MCP tools all come through the same two
functions. An agent's answer can be harvested into a training trace, so a name withheld from the
panel but handed to a tool would leak by the longer route. Neither the skill's helper nor the MCP
tools open a catalogue: a second judge of the rules is one drift away from a leak.

## Two refusals that are answers

- **No finished catalogue** is said, not hidden. "No match" would otherwise mean "not reached yet"
  rather than "not on the drive".
- **A changed file is not a copy.** A catalogued row counts only while the file it describes still
  has its catalogued size and mtime; a stale row reads as `changed`, never as a safe second copy.

## Walking the tree (S26)

A list of 237,508 duplicate sets is not a decision anyone makes; a folder that knows how much of
itself exists somewhere else is. Every folder therefore carries **two figures that must not be
merged**, because they are answers to different questions:

- **duplicated elsewhere** — content here whose bytes also exist outside this folder's subtree.
  A tree duplicated against another tree: **this is the one that can be retired.**
- **duplicated inside** — content duplicated within it, counted as _reclaimable_ copies (k−1, not
  all k). Retiring the tree would not fix this; de-duplicating inside it would.

On the real F: the single largest pair is a folder duplicated against _itself_ — 42.4 GB inside
`Pictures/2016/Pictures` — so collapsing the two would point the owner at the wrong job.

**The rollup is built once per pass by the summary worker**, never on the hub's request thread: it
measures 157 s over 1.1 million rows, and a 90-second query on that thread is the defect S21 spent
three verification rounds on. Until the worker has written it, the folder routes answer **202** and
say so; a rollup whose worker died is reported with its reason rather than left as an eternal
"still being worked out".

**`/library/neighbours` is a separate route on purpose.** Storing "where the other copies are" for
every folder meant testing every copy of every set against every ancestor — 45 minutes on the real
F:. Asked for one folder at a time, its own subtree bounds the query.

**The drive need not be attached.** Every figure comes from the catalogue, so the answer is
identical with the drive unplugged. A catalogue records which root it describes, and when the drive
cannot be asked who it is, the store is searched for the one that says it is this root. Identity
still wins when the drive _is_ there, because F: may be another drive tomorrow.

**Status codes.** `200` answered · `202` the rollup is still being built · `400` not a root this
machine offers · `403` not this machine · `404` no catalogue, or no such folder in this catalogue ·
`409` the catalogue has never finished · `412` no quarantine policy · `503` `ESTATE_STORE` unset.
`404` for an unknown folder and `404` for an uncatalogued drive carry different sentences, because
they are different problems.

## Audit

Walking the tree is **not** audited. Design point 10 audits the questions an _agent_ asks; the owner
clicking through their own folders is not that, and an event per click would bury the ones that
matter in a tamper-evident log.

Each agent query appends one `library_queried` event to that drive's library log (`.jsonl`, beside
its `.db`). It records the surface, the kind of question, how many rows were returned and how many
were withheld, and the pass it was answered from — never the query text and never a path, because
"find my CV" is itself private.

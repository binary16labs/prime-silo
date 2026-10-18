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

| Route | Answers |
| --- | --- |
| `GET /library` | each root's last pass, totals by kind, and the top duplicate sets |
| `POST /library` `{root}` | start or resume a pass (202), or 409 if one is running |
| `POST /library/stop` | stop the running pass, keeping what it committed |
| `GET /library.csv?root=` | every duplicate set as CSV, streamed from the worker's own list |
| `GET /library/find?root=&q=&kind=&limit=` | files whose path contains `q`, with `withheld` counting private matches and `total` the matches before the limit |
| `GET /library/duplicates?root=&offset=&limit=` | sets beyond the panel's top ten, most wasted first, read from the worker's list |
| `POST /library/check` `{path, root}` | is this file, or every file under this folder, already on the drive: `on-root` with where, `changed`, or `absent` |

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

## Audit

Each agent query appends one `library_queried` event to that drive's library log (`.jsonl`, beside
its `.db`). It records the surface, the kind of question, how many rows were returned and how many
were withheld, and the pass it was answered from — never the query text and never a path, because
"find my CV" is itself private.

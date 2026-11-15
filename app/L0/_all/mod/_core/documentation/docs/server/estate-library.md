# Estate Library

The drive catalogue the librarian keeps, and the routes that answer questions of it. S21 built the
catalogue and the panel's view of it; S22 added the three questions an agent asks.

## Primary Sources

- `server/coordination/lib/library.mjs`
- `server/coordination/lib/estate_api.mjs`
- `delivery/tasks/S21.md`, `delivery/tasks/S22.md`, `delivery/tasks/U1.md`

## Routes

All under `/api/estate/library`. Every one answers **this machine only** and needs a quarantine
policy, because the catalogue names files.

| Route                                            | Answers                                                                                                           |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| `GET /library`                                   | each root's last pass, totals by kind, and the top duplicate sets                                                 |
| `POST /library` `{root}`                         | start or resume a pass (202), or 409 if one is running                                                            |
| `POST /library/all`                              | Catalogue my data: every offered root in order, one pass at a time (202), or 409 while one runs                   |
| `POST /library/stop`                             | stop the running pass, keeping what it committed, and clear Catalogue my data's queue                             |
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
   (`commands/params.yaml`), resolved through `runtime_params` and passed by `server/app.js`, never
   a machine path shipped as a default. Since U1, a machine with no store keeps every catalogue on
   itself, in `BENNY_HOME/estate/library`, rather than refusing.

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

## How a pass finds its files, and when it runs (S23)

**Everything lists the drive; the walk is the fallback.** On Windows a pass takes its list of files
from Everything's index, which gives each file's size and date without touching the disk, so an
unchanged file costs neither a look nor a read. Both sources apply the same exclusions (the recycle
bin and system folders at the top, the estate store, the operating system's own files), so a listing
and a walk of one drive make the same catalogue. **A listing that may be incomplete never removes a
row**: if Everything is not available, if its listing fails, if it holds fewer than 99% of the files the
catalogue already holds, or if the last full walk is older than `ESTATE_LIBRARY_WALK_DAYS` (default 7),
the pass walks instead and records why. Each pass records `listed_by` (everything or walk),
`walk_reason` and `started_by` (owner or schedule); a catalogue from before S23 reads as the owner's walks.

**Everything must be reachable.** If Everything runs as administrator, an ordinary program cannot talk
to it (`es.exe` answers "IPC not found") and every pass walks, saying "Everything is not available for
this drive". Run Everything without administrator rights, or as its service, for listings to work.

**Rescans.** `ESTATE_LIBRARY_RESCAN_HOURS` (default 0, off) sets how often the hub rescans each drive
it has already catalogued. Every 15 minutes the `library_rescan` job asks which drive is due: attached,
catalogued here under its own identity, and last finished longer ago than the interval. One drive per
tick, through the same librarian the Catalogue button uses, so the two never run at once and Stop
stops either. A drive that is not attached, or a different drive at the same letter (it has no
catalogue under its identity), is never started and never counted as rescanned. The Library line says
how the last pass listed the drive, and when the next rescan is due or that rescans are off.

## The owner's data, Downloads first (U1)

**Offered from the drive registry, in the owner's order:** Downloads, OneDrive, the other known and
added folders, then data drives whole. A folder inside another root (Documents in OneDrive) is its
**section**, so no file is in two; an overlapping added folder is refused. Never the system drive
whole, nor Windows, Program Files, ProgramData or AppData: every route refuses them.

**Catalogue my data** runs them one at a time; a failing root is recorded and skipped; Stop clears
the queue, which lives in memory (after a restart, press it again: every pass resumes).

**Where catalogues live.** User roots and internal drives: `BENNY_HOME/estate/library`. Removable
drives: `ESTATE_STORE/library` when set, else `BENNY_HOME`. Lookups check both. (On the T480
`BENNY_HOME` is itself on F:.)

**OneDrive files not on this disk are never opened** (opening one downloads it). Before a user root's
pass, the directory listing's attributes say which are cloud-only; those go to `online_only` (path,
size, date), never `files`. An unreadable folder is not read; if Windows cannot answer, nothing is.
Compare and Check refuse any path inside OneDrive **or holding it** (U12). Check also probes what
it is asked about before reading: a cloud-only file reads `online-only`, unopened, and if Windows
cannot say, the check reads nothing.

**Compare** (S20's Backups tab) takes Downloads as "from": "In Downloads, not on F:", F: asked through
its catalogue.

## What is only outside F: (U6)

Stage 2 of the signed `PLAN-consolidate-first`. `GET /library/sole` answers, per source (every
offered root but F:, and every catalogued drive that is away, dated), from the catalogues alone:
files and bytes **to copy onto F:** (content F: lacks, by sha256, so a file F: holds under another
name is already there; a source's own repeats are said separately), **already on F:**, and **cannot
tell** (cloud-only rows have no fingerprint and are never called "on F:"). A worker computes it off
the hub's thread, current for both catalogues' last passes and the policy.
`GET /library/sole.csv?root=` is the list; private files are counted, never listed.

## The copy plan (U7)

Stage 3a of the signed plan. `GET /library/plan` gives, per source and from the catalogues alone,
what would be added to F: and where (`F:\consolidated\<source>\<path>`; `<source>` is the role,
else the drive's given name, else its short identity), whether it fits (5% margin), repeats copied
once, names already on F: renamed visibly, what the policy leaves out, and cloud-only files never
planned. `coordination/estate/storage-policy.json` is the owner's (`POST /library/policy`, validated,
logged; the target never leaves the signed drive). `POST /library/plan/raise` puts a plan forward as a
`proposal_raised` in the governance log with its exact digest; **only the owner signs**, in
Governance, and a newer pass makes a new, unsigned plan. Nothing is copied here (U8).

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

**The rollup has its own key, and a missing one starts the worker (S30).** Only the summary's key
used to, so a catalogue summarised before S26 existed — the real F:, whose pass finished the day
before S26 merged — had a current summary, started nothing, and answered "try again in a minute"
for as long as anyone asked. Now either key being behind is enough, and a catalogue whose summary
and rollup are both current starts nothing. A `202` promises a minute **only while a worker is
building**: while a pass of that drive is running the answer says the figures come when the pass
ends, because nothing builds a rollup mid-pass and a first pass of F: is hours. A build that failed
**rests for a minute before it is tried again**, and says why for that minute; the next ask after it tries again — starting a worker used
to clear the failure, so the request that came to read the reason was the one that erased it.

**The top of a drive is never answered by a scan (S31).** The files sitting directly in a drive's
top folder are found through a small partial index, `files_root`, which only a catalogue pass used
to create. F:'s last pass predates it, and the fallback — sort every file on the drive by size and
keep the ones at the top — took 12 to 49 seconds over F:'s 1.1 million rows on its USB disk, on the
hub's only request thread, so the whole app stopped answering while it ran. Now the worker that
builds the folder figures builds that index too, with the same statement the schema uses; a
missing index starts the worker exactly as a missing rollup does; and until the index exists the
top folder answers `202`, still being worked out, rather than scanning. The worker redoes only what
is not already current, so a catalogue that lacks only the index gets only the index.

**`/library/neighbours` is a separate route on purpose.** Storing "where the other copies are" for
every folder meant testing every copy of every set against every ancestor — 45 minutes on the real
F:. Asked for one folder at a time.

**And it is capped, which is the part that matters.** A subtree range over the path index was not
enough: with the privacy judgement applied per file, a 250,000-file folder cost **93.5 seconds** on
the hub's thread — worse than the 5.7-second table scan it replaced, because two correct privacy
fixes composed. An index fixes a query; only a bound fixes a placement. So the route reads the
folder's file count from the rollup first and **refuses above 1,500 files**, naming the count and
the cap: `Pictures holds 250000 files, and comparing more than 1500 would block the hub: ask of a
folder inside it`. It refuses rather than truncating, because "the other copies are in these
folders" is a claim about all of them and a partial answer to it is a wrong one. Below the cap it
costs about 140 ms. If no rollup has been written yet the answer is **202**, not a comparison.

Expect this refusal on the big top-level trees — which is where the weight usually is. Extending
the feature to answer them coarsely is a separate contract, not a cap to raise.

**The drive root is refused.** Everything on the drive is inside the root, so "which folders hold
copies from outside it" has no answer — asked anyway it named every folder on the drive, which is
wrong rather than merely slow. The rollup already answers the root's question.

**The privacy judgement is symmetric.** Both sides of a comparison are judged, not only the far
one. Asking the neighbours of a folder that _holds_ a quarantined file used to name the folder
holding its twin, which identifies that private file's content just as surely as naming it would.
A withheld near file is counted; its copies are simply never looked for. A rule that matches a
**folder** matches everything beneath it, so a folder withheld at its parent cannot be walked into
and read file by file.

**The drive need not be attached.** Every figure comes from the catalogue, so the answer is
identical with the drive unplugged. A catalogue records which root it describes, and when the drive
cannot be asked who it is — and _only_ then — the store is searched for the one that says it is this
root; that answer is marked `by_name: true`, because a recorded name is not an identity. Identity
wins whenever the drive _is_ there: if the drive can say who it is and has no catalogue of its own,
the truth is "no catalogue", not another disk's figures. Two catalogues claiming one absent root are
**refused** rather than chosen between — a disk that has been F: twice leaves exactly that, and it is
the normal case. And a rollup that does not match **both** the catalogue's own pass and the hub's own
privacy policy is refused rather than served: taking the stored key and comparing it with itself
checked nothing, and the pass half is no harder than the policy half, because the pass is read from
the catalogue, which is present by definition. A stale figure wearing a current date is worse than a
refusal.

**What the answers mean.** Two of these figures share a word and do not share a meaning, which is
worth knowing before adding them up:

| field                         | on `/library/find`                                        | on `/library/check`                                                   |
| ----------------------------- | --------------------------------------------------------- | --------------------------------------------------------------------- |
| `total`                       | matches **before the limit** — how much there was to find | the files it was **asked about**                                      |
| `withheld`                    | matches the privacy rules cover                           | both channels: paths never walked, and catalogued locations not named |
| `capped`                      | —                                                         | the **walk** stopped at its cap                                       |
| `paths_given` / `paths_taken` | —                                                         | how many paths were handed over, and how many of them were used       |

Each carries its own `total_means` so a caller never has to guess which it has. A `withheld` figure
is the most that may be said about a quarantined path: counted, never named.

**`/library/check` is bounded before it does any work.** It takes at most 200 paths at a time —
the walk has had a cap since S21, but the input list had none, and 20,000 paths cost 2.7 seconds of
the hub's thread. The cap is applied before a single file is hashed, and over it the answer says
what it took and what it did not.

**`/library/find` is not bounded, and saying so is the point.** A find with neither a word nor a
kind is **refused**, because an empty query matches every row and would walk the whole drive to
return the first fifty of it. But a **kind on its own is still a full table scan** — there is no
index on `kind` — measured at **13.5 seconds over 500,001 rows** on the hub's own thread, and a
broad word is no better (`q="."` measured 12.6 s). Refusing the emptiest question closed one shape
of several. Bounding this route is a separate piece of work and this page is not going to imply
otherwise.

**A folder your own rules cover is explained, not answered with a blank.** When every path asked
about is quarantined, the answer carries the sentence as well as the count — a bare `total: 0` told
the owner nothing about why.

**Two answer fields are sentences, not figures.** On `/library/check`, `why` is present only when
every path asked about was covered by the rules, and says so; `why_capped` is present only when
more paths were given than the check will take at once, and says how many it took. `capped` is a
different thing — the _walk_ stopped at its cap — so an answer can carry `why_capped` with
`capped: false`.

**A question the librarian was asked is audited whether it was answered or refused** — the `404` of
an uncatalogued drive and the `409` of a declined question both write an event. The rejections that
happen _before_ the librarian is consulted do not: a `400` for an unoffered root or a missing path,
a `405`, a `412` with no policy, a `503` with no store. Those are the hub declining to take the
question at all, and the root they name has not been validated, so there is nothing safe to key an
event to. Nothing is written when the caller has already
hung up, because an answer nobody received is not one to record. Walking the tree in the panel stays
unaudited: that is navigation.

**Status codes.** `200` answered · `202` the rollup is still being built, a pass of the drive is
running, or (on `/library/duplicates` and `/library.csv`) the duplicates list is still being worked
out · `400` not a root this
machine offers, or no path given · `403` not this machine · `404` no catalogue, or no such folder in
this catalogue ·
`409` the catalogue has never finished, the drive root was asked for its outside, the folder holds
more files than `/library/neighbours` will compare, the store holds two catalogues claiming one
absent root, or a rollup does not match the catalogue's pass and the hub's policy ·
`412` no quarantine policy · `503` `ESTATE_STORE` unset. A `find` with nothing to find is also a
`409`, because it is the hub declining a question rather than failing to answer one.
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

# Prime-Silo Agent Navigation

> For Claude and other agents working on Prime-Silo

---

## Current Status (as of 2026-07-09)

**Latest Release:** v1.15.0 (LONGVIEW v2 deterministic graph)  
**New in 1.15.0:** a new **`graph`** phase (longview_v2) builds the knowledge graph **deterministically from the cards' own structured fragments** — no `deep_synthesis` LLM re-extraction. The `map` phase already distils each session into `concepts[]`/`applications[]`/`capabilities[]`/`skills_observed[]`, so a second LLM pass was pure redundancy. `graph` maps those arrays straight into the same `Source`/`Concept`/`RELATES_TO`/`SOURCED_FROM` schema at **~0.4 s/card** (vs ~60-120 s/card for deep_synthesis), via `scripts/longview/lib/card_triples.mjs` (pure `buildCardTriples`) → new server route `POST /rag/graph-upsert` → `save_knowledge_triples` (no clustering). Topology is `(:Project)-[INVOLVES/USES/DEMONSTRATES/APPLIES]->` entities + an anchor `CO_OCCURS_WITH` star per card ("cards at the centre, concepts radiating"); `enrich` then merges duplicate concepts across cards into shared hubs. A live **earned ETA** (EMA of real per-card times) + good/blank/errored counts stream to `<workspace>/longview/progress.json` (`scripts/longview/lib/eta.mjs`). Verified live against Neo4j. The generation model stays env/profile-driven (`BENNY_DEFAULT_MODEL`/`LONGVIEW_MODEL`); verified LAN setup is LM Studio serving `google/gemma-4-12b`. See `runtime/docs/operations/LONGVIEW_GUIDE.md`.  
**New in 1.11.0:** `scripts/longview/audiobook/` — deterministic 3-stage pipeline that turns the _The AI Vampire_ book output into a narrated audiobook via **Voicebox** (local TTS). `01_prepare.py` cleans markdown to `#`-free, citation-stripped per-chapter narration text + a fixed-order `manifest.json`; `02_run_kokoro.py` drives the Voicebox backend (`POST /generate`, Kokoro engine ~0.35× real-time on CPU vs ~10× for cloned qwen) into one WAV per chapter; `03_stitch.py` concatenates them in manifest order (stdlib `wave`, no ffmpeg) with an inter-chapter silence gap + chapter cue sheet. Voicebox = source repo at `binary16/voicebox` (FastAPI on :17493, MCP at `/mcp`); registered in Claude user config. Set `LONGVIEW_BOOK_DIR` to point the pipeline at the book output.  
**New in 1.10.1:** kg3d synoptic-web `/graph/full` fallback capped at 400 nodes — fixes "Maximum call stack size exceeded" on the Documents tab at post-synthesis graph sizes (~30k concepts); LONGVIEW phase isolation (a throwing phase is ledgered `phase_error`, never fatal to the run), opus outline validation requires a non-empty list, reduce retries empty model replies and never overwrites a real deliverable with nothing, case-variant project dossiers merged. Book path is standalone: `reduce --only dossiers,themes,report` → `opus` → `pdf` (no ingest needed) — see `runtime/docs/operations/LONGVIEW_GUIDE.md`  
**New in 1.10.0:** LONGVIEW code/weave/opus/pdf phases (code graph via `benny enrich`, discovery loops, _The AI Vampire_ 200+ page book, print PDF); hierarchical outline for 4k-ctx local models; single large ingest batch amortizes the per-batch clustering pass  
**All Packages:** Built and published for 6 platforms (Windows, macOS, Linux × x64 + ARM64)

---

## Architecture in One Sentence

Prime-Silo is a deterministic execution platform (Benny runtime backend + Space-Agent React frontend) with two zones: deterministic manifests (read-only for agents) and a review sandbox (where agents can draft views and analyses). All changes are signed, versioned, and auditable.

---

## What Agents Need to Know

### 1. Agent Authority (Strict Boundaries)

**You CAN:**

- ✅ Read manifests from L1/ and L2/
- ✅ Read past runs and lineage
- ✅ Query system state (home directory, config, graphs)
- ✅ Create draft views in `agent_sandbox/views/`
- ✅ Write analyses to `agent_sandbox/drafts/`
- ✅ Query memory graph and sessions
- ✅ Generate AI-powered reports and analyses
- ✅ Plan manifests (advisory, not executed)

**You CANNOT:**

- ❌ Execute manifests directly (`benny run` / `benny pypes run`)
- ❌ Mutate files in L1/ or L2/ (requires human signature)
- ❌ Delete or modify run history
- ❌ Sign or pin views (only humans can)
- ❌ Change configuration files
- ❌ Write outside `agent_sandbox/`

**Why:** ADR-001 determinism boundary. Deterministic zone is read-only for agents; review zone (agent_sandbox) is where you draft and humans approve.

See **[AGENT-AWARENESS.md](AGENT-AWARENESS.md)** for complete details.

### 2. System State Queries

**Home Directory (Electron desktop):**

```javascript
// Full resolved report: { homeDir, home: { root, source, bennyHome, customwarePath, warnings } }
const { home } = await ipcRenderer.invoke("space-desktop:get-home-directory");
// Or, from anywhere with server access: fetch("/api/home") — same report + provenance.
// See HOME-DIRECTORY.md for the precedence rules and legacy handling.
```

**Configuration:**

```bash
fetch("/api/config").then(r => r.json())  // All runtime config
```

**Registered Manifests:**

```bash
node space registry           # List all manifests
fetch("/api/manifests")       # Via API
```

**Run History:**

```bash
benny runs ls --limit 10      # Past 10 runs
fetch("/api/runs?limit=10")   # Via API
```

**Memory Graph:**

```bash
node space memory status      # Check if Memo-Ray connected
node space memory search "<query>"  # Search sessions
```

### 3. APIs You Can Use

See **[AGENT-AWARENESS.md](AGENT-AWARENESS.md)** for complete API reference.

**Key endpoints:**

- `/api/config` — Runtime configuration
- `/api/manifests` — Registered manifests
- `/api/runs` — Run history
- `/api/graph/*` — Knowledge/code graphs
- `/api/lifelog` — Session activity feed
- `/api/integration_audit` — Check service status

### 4. Skills Available

**benny-pilot** — Manifest and run introspection

```javascript
const pilot = await import("/mod/_prime_silo/memoray_client/ext/skills/benny-pilot/benny-pilot.js");
// Methods: queryManifests(), inspectRun(), etc.
```

**memory-recall** — Session history

```javascript
const recall =
  await import("/mod/_prime_silo/memoray_client/ext/skills/memory-recall/memory-recall.js");
// Methods: search(), getSessionContext(), etc.
```

**project-guide** — Project-specific knowledge

```javascript
// Available when working in the app
// Provides project context and suggestions
```

---

## How to Get Help

### Finding What You Need

| Question                             | Go to                                           |
| ------------------------------------ | ----------------------------------------------- |
| "How do I set up the desktop app?"   | [QUICKSTART-EXE.md](QUICKSTART-EXE.md)          |
| "What CLI commands are available?"   | [CLI.md](CLI.md)                                |
| "What can I do as an agent?"         | [AGENT-AWARENESS.md](AGENT-AWARENESS.md)        |
| "Where is everything documented?"    | [INDEX.md](INDEX.md)                            |
| "How does the release process work?" | [DEVOPS.md](DEVOPS.md)                          |
| "What's the project architecture?"   | [AGENTS.md](AGENTS.md) + [README.md](README.md) |
| "How do I use the CLI?"              | [GUIDE.md](GUIDE.md)                            |

### Common Tasks

**Check current version:**

```bash
node space version
cat package.json | jq .version
```

**Explore workspace:**

```bash
# Read config
fetch("/api/config").then(r => r.json())

# List manifests
node space registry

# Get home directory (Electron)
await ipcRenderer.invoke("space-desktop:get-home-directory")
```

**Analyze a run:**

```bash
# Get run details
benny runs inspect <run_id>

# Get lineage
benny pypes drilldown <run_id> <stage>

# Generate analysis report
benny pypes agent-report <run_id>
```

**Create a draft:**

```javascript
// Write to sandbox
const draft = {
  format: "aamp.view/1",
  title: "My Analysis",
  created_from_run: "<run_id>",
  panels: [...]
};

fetch("/api/files/agent_sandbox/views/analysis.draft.view", {
  method: "POST",
  body: JSON.stringify(draft)
});
```

---

## Release Process (For Handoff)

**If you need to create a release, see [DEVOPS.md](DEVOPS.md).**

Quick version:

1. Make sure all changes are committed to main
2. Run: `node scripts/manage-release.js [patch|minor|major]`
3. Push commits: `git push origin main`
4. Push tag: `git push origin v1.2.X`
5. Wait ~30 minutes for all platforms to build
6. Release published to GitHub automatically

**Critical:** Always push main before pushing tag, or build jobs will be skipped!

---

## Project Layout

```
prime-silo/
├── README.md                    ← Start here
├── INDEX.md                     ← Doc navigation
├── QUICKSTART-EXE.md           ← Desktop app setup
├── CLI.md                       ← All commands
├── AGENT-AWARENESS.md          ← You are here (agent perms)
├── GUIDE.md                     ← UI walkthrough
├── DEVOPS.md                    ← Release process
├── HOME-DIRECTORY.md            ← Workspace structure
├── AGENTS.md                    ← Architecture contracts
├── CLAUDE.md                    ← This file
│
├── app/                         ← React frontend
├── server/                      ← Node.js API server
├── commands/                    ← CLI commands
├── packaging/                   ← Desktop build (Electron)
├── runtime/                     ← Vendored Benny backend
├── scripts/                     ← Development scripts
│   └── manage-release.js       ← Release tool
└── .github/workflows/          ← CI/CD pipelines
    ├── release-desktop.yml     ← Build all platforms
    └── snapshot-build.yml      ← Auto on every commit
```

---

## Key Files You'll Touch

| File                                    | Purpose            | When                        |
| --------------------------------------- | ------------------ | --------------------------- |
| `package.json`                          | Version source     | Release time (auto-updated) |
| `README.md`                             | Project intro      | User-facing updates         |
| `CLAUDE.md`                             | Agent navigation   | Meta/handoff updates        |
| `AGENTS.md`                             | Architecture rules | Major decisions             |
| `DEVOPS.md`                             | Release process    | Release time reference      |
| `.github/workflows/release-desktop.yml` | Build pipeline     | Understanding CI/CD         |
| `scripts/manage-release.js`             | Release automation | Actually releasing          |

---

## Common Patterns

### Reading System State

```javascript
// Get home directory
const config = await fetch("/api/config").then((r) => r.json());
const homeDir = config.customware_path;

// Or (in Electron):
// Full resolved report: { homeDir, home: { root, source, bennyHome, customwarePath, warnings } }
const { home } = await ipcRenderer.invoke("space-desktop:get-home-directory");
// Or, from anywhere with server access: fetch("/api/home") — same report + provenance.
```

### Creating Analysis Drafts

```javascript
// 1. Get a run
const runs = await fetch("/api/runs?limit=1").then(r => r.json());
const run = runs[0];

// 2. Generate analysis (advisory)
const analysis = {
  created_from_run: run.run_id,
  findings: [...],
  recommendations: [...]
};

// 3. Write to sandbox (only place you can write)
await fetch("/api/files/agent_sandbox/drafts/analysis.json", {
  method: "POST",
  body: JSON.stringify(analysis)
});

// 4. Notify user (not automatic)
console.log("Draft saved. Waiting for human review...");
```

### Querying Lineage

```bash
# Full lineage for a run
benny runs inspect <run_id>

# Drill down into a stage
benny pypes drilldown <run_id> <stage_name>

# Get metadata
fetch("/api/runs/<run_id>/lineage").then(r => r.json())
```

### Planning (Advisory Only)

```bash
# AI-generate a manifest (doesn't execute)
benny pypes plan "transform data from JSON to Parquet" --save

# Now it exists as a draft
# Humans execute it with: benny pypes run manifests/...
```

---

## Troubleshooting

### "Home not configured"

- User needs to right-click system tray icon
- Select "Configure Home..." (one home; benny/ + customware/ derive from it — see HOME-DIRECTORY.md)
- Choose a folder

### "Can't execute manifest"

- Check if it's in deterministic zone (read-only for agents)
- Only humans can execute manifests
- You can plan them (advisory) but not run them

### "Memory graph not connected"

- Check if Memo-Ray is running
- Verify MEMORAY_BASE_URL is set
- Query `/api/integration_audit?service=memoray`

### "API endpoint not found"

- Check if service is running (`node space serve`)
- Verify `/api/config` returns valid config
- Check proxy configuration

---

## Before Handing Off to Next Agent

Create a summary like this:

```bash
# Current state
git log --oneline -5
git status
gh release list --limit 3
gh run list --workflow=release-desktop.yml --limit 1

# What's running
node space version
fetch("/api/config")

# Any pending work?
# (List here: PRs, TODOs, known issues)
```

Then update this file (CLAUDE.md) with:

- Current version
- What was accomplished
- What needs attention next

---

## Resources

**Official Docs:**

- [Prime-Silo GitHub](https://github.com/binary16labs/prime-silo)
- [Benny (runtime)](https://github.com/skybluecycology/benny)
- [Space-Agent (shell)](https://github.com/agent0ai/space-agent)

**This Project:**

- [README.md](README.md) — Project overview
- [INDEX.md](INDEX.md) — All documentation
- [AGENTS.md](AGENTS.md) — Architecture contracts
- [runtime/CLAUDE.md](runtime/CLAUDE.md) — Benny-specific agent guide

---

## Quick Commands Cheatsheet

```bash
# Status
git status && node space version && fetch("/api/config")

# Navigation
node space help

# Configuration
node space get
node space set CUSTOMWARE_PATH=/home/user/workspace

# Querying
node space registry                      # Manifests
benny runs ls --limit 10                # Run history
node space memory sessions              # All sessions

# Creating (always to sandbox)
benny pypes plan "requirement"          # Draft manifest
benny pypes agent-report <run_id>       # Draft analysis

# Development
npm ci --prefix server
node space serve CUSTOMWARE_PATH=$HOME/.benny

# Release (see DEVOPS.md)
node scripts/manage-release.js patch
git push origin main && git push origin v1.2.X
```

---

**Last updated:** 2026-07-03  
**Release v1.10.1:** ✅ Complete  
**Next agent:** Welcome! Please update this file when you hand off.

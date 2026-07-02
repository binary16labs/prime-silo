# Prime-Silo Command-Line Reference

> Complete reference for all CLI commands in Prime-Silo

## Overview

Prime-Silo has **two command-line interfaces**:

1. **Node.js CLI** (`node space`) — controls the local server and configuration
2. **Benny Python CLI** (`benny`) — executes transformations and workflows

Most users won't need the CLI if they're using the desktop app. The CLI is useful for:

- Automation and scripting
- Server management
- Advanced manifest operations
- Development and debugging

### Easiest way to get a Benny CLI (packaged app)

You don't need a dev checkout or manual environment setup. In the desktop app,
**right-click the tray icon → "Open Benny CLI"** — it opens a terminal with
`$BENNY_HOME` set and `bin/` on `PATH`, so `benny …` works immediately:

```bash
benny runs ls --limit 10
benny plan "score trades for credit risk" --workspace demo --save
```

The tray also drives the runtime itself: **Start/Stop Benny services** and
**Set up environment (init + doctor)** — no `scripts/dev.ps1` or `node space
serve` by hand. (First run: **Configure Benny Home…** to point at your
`$BENNY_HOME`.)

### Spreading model calls across machines

Local providers can address more than one endpoint, so a fanned-out run (the
swarm, or **Deep produce**) parallelizes across boxes instead of serializing on
one model server:

```bash
# Comma-separated, per provider:
BENNY_LEMONADE_ENDPOINTS=http://ryzen.local:13305/api/v1,http://t480.local:13305/api/v1

# Or JSON, multiple providers at once:
BENNY_MODEL_ENDPOINTS='{"lemonade":["http://ryzen.local:13305/api/v1","http://t480.local:13305/api/v1"]}'
```

With one endpoint, fan-out stays sequential (still a quality win). Pool members
are LAN hosts of the same local provider, so the offline guard still treats them
as local.

---

## Part 1: Node.js CLI Commands

Run from the Prime-Silo project root directory using: `node space <command>`

### `serve` — Start the Server

Starts the local Prime-Silo server and serves the browser UI.

**Usage:**

```bash
node space serve [OPTIONS]
```

**Common Options:**

- `HOST=0.0.0.0` — Listen on all interfaces (default: `127.0.0.1`)
- `PORT=3000` — Port to listen on (default: `3000`)
- `CUSTOMWARE_PATH=/path/to/workspace` — Home directory for data storage
- `WORKERS=1` — Number of worker processes

**Examples:**

```bash
# Basic startup
node space serve

# Custom port and home directory
node space serve PORT=8080 CUSTOMWARE_PATH=/srv/prime-silo-data

# Allow network access (e.g., from other machines)
node space serve HOST=0.0.0.0 PORT=3000

# With multiple workers (clustered mode)
node space serve WORKERS=4 CUSTOMWARE_PATH=/srv/data
```

**Output:**

```
space server version 1.2.2
space server listening at http://127.0.0.1:3000
```

### `supervise` — Run with Auto-Updates

Runs the server with automatic updates and zero-downtime restarts.

**Usage:**

```bash
node space supervise CUSTOMWARE_PATH=/path/to/workspace [OPTIONS]
```

**Required:**

- `CUSTOMWARE_PATH` — Home directory (required for supervision)

**Options:**

- `--branch <branch>` — Git branch to watch (default: current branch)
- `--auto-update-interval <seconds>` — Check for updates every N seconds (default: 300)
- `--startup-timeout <seconds>` — Maximum time to wait for child to start (default: 30)

**Examples:**

```bash
# Basic supervised mode
node space supervise CUSTOMWARE_PATH=/srv/prime-silo-data

# Custom update interval (check every 10 minutes)
node space supervise CUSTOMWARE_PATH=/srv/data --auto-update-interval 600

# Disable auto-updates, keep crash-restart supervision only
node space supervise CUSTOMWARE_PATH=/srv/data --auto-update-interval 0
```

### `user` — Manage Users

Create and manage workspace users.

**Usage:**

```bash
node space user create <username> [OPTIONS]
```

**Options:**

- `--groups <group[,group...]>` — Comma-separated list of groups to add user to
- `CUSTOMWARE_PATH=/path` — Home directory containing users

**Examples:**

```bash
# Create a user
node space user create alice

# Create user and add to groups
node space user create bob --groups developers,admins

# With custom home directory
node space user create charlie --groups analysts CUSTOMWARE_PATH=/srv/data
```

### `group` — Manage Groups

Create and manage workspace groups.

**Usage:**

```bash
node space group add <groupname> [OPTIONS]
```

**Examples:**

```bash
# Create a group
node space group add developers

# Add user to group
node space group add developers --user alice
```

### `get` / `set` — Manage Configuration

Get and set configuration parameters.

**Usage:**

```bash
node space get [PARAMETER]
node space set PARAMETER=VALUE
```

**Common Parameters:**

- `HOST` — Server listening address
- `PORT` — Server listening port
- `CUSTOMWARE_PATH` — Home directory path
- `CUSTOMWARE_WATCHDOG` — Enable live file watching (true/false)
- `WORKERS` — Number of worker processes
- `LOGIN_ALLOWED` — Enable login (true/false)
- `ALLOW_GUEST_USERS` — Allow guest users (true/false)
- `CLOUD_SHARE_ALLOWED` — Enable cloud sharing (true/false)

**Examples:**

```bash
# Get all settings
node space get

# Get one setting
node space get PORT

# Set a setting
node space set PORT=8080

# Persist a setting
node space set CUSTOMWARE_PATH=/srv/prime-silo-data
```

### `version` — Show Version

Displays the current Prime-Silo version.

**Usage:**

```bash
node space version
```

**Output:**

```
prime-silo version 1.2.2
```

### `help` — Show Command Help

Display help for all commands or a specific command.

**Usage:**

```bash
node space help [COMMAND]
```

**Examples:**

```bash
# Show all available commands
node space help

# Show help for serve command
node space help serve

# Alias
node space --help
```

### `update` — Update from Git

Updates the source checkout from the configured Git repository.

**Usage:**

```bash
node space update [OPTIONS]
```

**Options:**

- `--branch <branch>` — Update to specific branch
- Tag or commit hash — Update to specific version

**Examples:**

```bash
# Fast-forward current branch
node space update

# Switch to main branch and update
node space update --branch main

# Update to specific tag
node space update v1.2.2
```

### `memory` — Memory Graph Operations

Manage session history and memory graph.

**Usage:**

```bash
node space memory <subcommand> [OPTIONS]
```

**Subcommands:**

- `status` — Check Memo-Ray connection status
- `sync` — Sync session data with Memo-Ray
- `sessions` — List all sessions
- `search <query>` — Search sessions
- `audit` — Audit memory integration

**Examples:**

```bash
# Check if memory graph is connected
node space memory status

# List all sessions
node space memory sessions

# Search for sessions mentioning "manifest"
node space memory search manifest
```

### `bridge` — Bridge Cockpit Operations

Control the unified Bridge cockpit interface.

**Usage:**

```bash
node space bridge <subcommand> [OPTIONS]
```

**Subcommands:**

- `status` — Check Bridge integration status
- `plan <requirement>` — AI-generate manifest from requirement
- `run <manifest>` — Execute manifest via Bridge
- `ingest <files>` — Ingest documents into knowledge graph
- `open <mode>` — Open Bridge in specified mode

**Examples:**

```bash
# Check Bridge status
node space bridge status

# Plan a new manifest
node space bridge plan "analyze customer data and generate report"

# Open to specific mode (pulse, memory, documents, code, flows, runs)
node space bridge open pulse
```

### `registry` — Query Module Registry

Query the installed module registry.

**Usage:**

```bash
node space registry [OPTIONS]
```

**Examples:**

```bash
# List all registered modules
node space registry

# Query registry info
node space registry --info
```

---

## Part 2: Benny Python Commands

Run from the Prime-Silo project root using: `python -m benny <command>`

Or if Benny is installed globally: `benny <command>`

### `plan` — AI-Generate Manifest

Use an AI model to generate a manifest from a text requirement.

**Usage:**

```bash
benny plan "<requirement>" [OPTIONS]
```

**Options:**

- `--workspace <name>` — Workspace to save to
- `--save` — Save generated manifest
- `--run` — Execute generated manifest immediately
- `--strategy <type>` — Planning strategy: `auto`, `oneshot`, `incremental`, `swarm`

**Examples:**

```bash
# Generate a manifest from requirement
benny plan "transform CSV to Parquet with validation"

# Generate and save
benny plan "analyze logs for errors" --save --workspace analytics

# Generate and execute immediately
benny plan "validate data quality" --run --workspace default
```

### `run` — Execute Manifest

Execute a Pypes manifest (transformation pipeline).

**Usage:**

```bash
benny run <manifest.json> [OPTIONS]
```

**Options:**

- `--workspace <name>` — Workspace context
- `--resume <run_id>` — Resume from checkpoint
- `--json` — Output results as JSON

**Examples:**

```bash
# Run a manifest
benny run manifests/templates/data_transform.json

# Run in specific workspace
benny run manifests/pipeline.json --workspace analytics

# Resume from checkpoint
benny run manifests/pipeline.json --resume abc123
```

### `runs` — Manage Run History

List and manage manifest runs.

**Usage:**

```bash
benny runs ls [OPTIONS]
benny runs inspect <run_id>
```

**Options:**

- `--workspace <name>` — Filter by workspace
- `--limit <N>` — Show last N runs
- `--json` — JSON output

**Examples:**

```bash
# List recent runs
benny runs ls --limit 10

# List runs in workspace
benny runs ls --workspace analytics

# Inspect a specific run
benny runs inspect abc123def456
```

### `longview` — Session Synthesis Pipeline

Run the LONGVIEW long-horizon session synthesis (ADR-005): agent-session
backlog → knowledge graph + cited deliverables (report, PRD, skill, book,
TOGAF prep). Defined by `manifests/templates/longview_synthesis.json`.

**Usage:**

```bash
benny longview run [--manifest <path>] [--phase <id>] [--delta]
benny longview status
benny longview report
```

**Options:**

- `--phase <id>` — Run one phase: `inventory` | `extract` | `map` | `model` | `reduce`
- `--delta` — Only new/changed sessions since the last run
- `--manifest <path>` — Alternate manifest (default: `manifests/templates/longview_synthesis.json`)

**Examples:**

```bash
# Full backlog (resume-safe — Ctrl+C and rerun anytime)
benny longview run

# Re-run graph ingestion only (deep synthesis)
benny longview run --phase model

# Keep the picture current after the backlog is done
benny longview run --delta

# Honest ledger report: throughput, tokens, failed session ids
benny longview report
```

**See:** [runtime/docs/operations/LONGVIEW_GUIDE.md](runtime/docs/operations/LONGVIEW_GUIDE.md)

### `pypes run` — Transformation Pipeline

Execute a Pypes transformation (data pipeline with bronze/silver/gold stages).

**Usage:**

```bash
benny pypes run <manifest.json> [OPTIONS]
```

**Options:**

- `--workspace <name>` — Workspace context
- `--resume <run_id>` — Resume from checkpoint

**Examples:**

```bash
# Run a Pypes pipeline
benny pypes run manifests/templates/financial_risk_pipeline.json --workspace analytics

# Resume from previous run
benny pypes run manifests/pipeline.json --resume xyz789
```

### `pypes inspect` — Validate Manifest

Validate and inspect a Pypes manifest.

**Usage:**

```bash
benny pypes inspect <manifest.json>
```

**Examples:**

```bash
# Validate manifest syntax and structure
benny pypes inspect manifests/my_pipeline.json
```

### `pypes drilldown` — Analyze Results

Drill down into Pypes run results with lineage annotations.

**Usage:**

```bash
benny pypes drilldown <run_id> <stage> [OPTIONS]
```

**Options:**

- `--workspace <name>` — Workspace context
- `--rows <N>` — Show N rows (default: 20)

**Examples:**

```bash
# Drill down into gold stage results
benny pypes drilldown abc123 gold_exposure --workspace analytics

# Show more rows
benny pypes drilldown abc123 silver_trades --rows 50
```

### `pypes rerun` — Resume from Step

Re-execute a pipeline from a specific step onward.

**Usage:**

```bash
benny pypes rerun <run_id> --from <step_name> [OPTIONS]
```

**Examples:**

```bash
# Re-run from silver stage onward
benny pypes rerun abc123 --from silver_validation --workspace analytics
```

### `pypes plan` — AI-Generate Pipeline

Use AI to generate a Pypes manifest from requirements.

**Usage:**

```bash
benny pypes plan "<requirement>" [OPTIONS]
```

**Options:**

- `--workspace <name>` — Workspace context
- `--save` — Save generated manifest
- `--run` — Execute immediately
- `--strategy <type>` — `auto`, `oneshot`, `incremental`, `swarm`

**Examples:**

```bash
# Generate a data pipeline
benny pypes plan "transform raw sales data to dimensional schema" --workspace analytics

# Generate and save
benny pypes plan "financial risk assessment" --save --workspace risk
```

### `pypes agent-report` — AI Analysis

Generate an AI-written risk or analysis report on a previous run.

**Usage:**

```bash
benny pypes agent-report <run_id> [OPTIONS]
```

**Examples:**

```bash
# Generate narrative report on run
benny pypes agent-report abc123 --workspace analytics
```

### `enrich` — Knowledge Enrichment

Enrich code graph or knowledge graph with semantic relationships.

**Usage:**

```bash
benny enrich --workspace <name> --src <source_dir> [OPTIONS]
```

**Options:**

- `--manifest <path>` — Use declarative enrichment manifest
- `--run` — Execute enrichment immediately
- `--resume <run_id>` — Resume previous enrichment

**Examples:**

```bash
# Enrich workspace with code analysis
benny enrich --workspace analytics --src src/ --run

# Use manifest-based enrichment
benny enrich --manifest manifests/knowledge_enrichment.json --workspace analytics --run
```

### `agentamp scaffold-skin` — Create Skin Pack

Create a new AgentAmp skin pack.

**Usage:**

```bash
benny agentamp scaffold-skin <id> [OPTIONS]
```

**Examples:**

```bash
# Create new skin pack
benny agentamp scaffold-skin my-theme

# With custom draft directory
benny agentamp scaffold-skin my-theme --drafts-dir ./skins
```

### `agentamp pack` — Package Skin

Package a skin draft into `.aamp` file.

**Usage:**

```bash
benny agentamp pack <draft_dir> --out <id>.aamp
```

**Examples:**

```bash
# Package skin
benny agentamp pack my-theme --out my-theme.aamp
```

### `agentamp sign` — Sign Skin

HMAC-sign a skin package for distribution.

**Usage:**

```bash
benny agentamp sign <id>.aamp
```

**Examples:**

```bash
# Sign skin (uses BENNY_HMAC_KEY environment variable)
benny agentamp sign my-theme.aamp
```

### `agentamp install` — Install Skin

Install and register a signed skin package.

**Usage:**

```bash
benny agentamp install <id>.aamp [OPTIONS]
```

**Examples:**

```bash
# Install skin to workspace
benny agentamp install my-theme.aamp --workspace analytics
```

### `agentamp enqueue` — Queue Manifest

Enqueue a manifest run to the AgentAmp cockpit.

**Usage:**

```bash
benny agentamp enqueue <manifest.json> [OPTIONS]
```

**Examples:**

```bash
# Enqueue manifest
benny agentamp enqueue manifests/pipeline.json --workspace analytics
```

### `up` / `down` — Service Lifecycle

Start or stop services (Neo4j, Marquez, etc.).

**Usage:**

```bash
benny up [OPTIONS]
benny down [OPTIONS]
```

**Examples:**

```bash
# Start all services
benny up

# Start in specific home directory
benny up --home /srv/benny-home

# Stop services
benny down --home /srv/benny-home

# Check status
benny status --home /srv/benny-home
```

---

## Environment Variables

Both CLI interfaces respect these environment variables:

| Variable             | Purpose                                      |
| -------------------- | -------------------------------------------- |
| `CUSTOMWARE_PATH`    | Home directory for workspace data            |
| `BENNY_HOME`         | Benny's internal home directory              |
| `BENNY_HMAC_KEY`     | HMAC key for signing manifests               |
| `OPENROUTER_API_KEY` | OpenRouter API key for cloud models          |
| `OLLAMA_BASE_URL`    | URL to Ollama server (if using local models) |
| `GIT_URL`            | Git repository URL for updates               |
| `MEMORAY_BASE_URL`   | Memo-Ray memory graph server URL             |

**Set environment variables:**

**PowerShell (Windows):**

```powershell
$env:CUSTOMWARE_PATH = "C:\Users\you\workspace"
$env:OPENROUTER_API_KEY = "sk-or-..."
```

**Bash (macOS/Linux):**

```bash
export CUSTOMWARE_PATH=/home/you/workspace
export OPENROUTER_API_KEY=sk-or-...
```

---

## Common Workflows

### 1. Local Development

```bash
# Terminal 1: Start Benny services
cd runtime
benny up --home ~/.benny

# Terminal 2: Start Prime-Silo server
npm ci --prefix server
node space serve CUSTOMWARE_PATH=$HOME/.benny/workspaces/default

# Open browser
open http://localhost:3000
```

### 2. Running a Transformation

```bash
# Plan manifest via AI
benny plan "clean and validate customer data" --save --workspace work

# Execute transformation
benny run manifests/customer_data.json --workspace work

# Inspect results
benny runs inspect abc123 --workspace work
```

### 3. Server Deployment

```bash
# Set up configuration
node space set CUSTOMWARE_PATH=/srv/prime-silo-data
node space set PORT=3000

# Run with auto-updates
node space supervise \
  CUSTOMWARE_PATH=/srv/prime-silo-data \
  HOST=0.0.0.0 \
  --auto-update-interval 300
```

### 4. Backup and Restore

```bash
# Backup home directory
cp -r /srv/prime-silo-data /backups/prime-silo-data-2026-06-17

# Restore from backup
cp -r /backups/prime-silo-data-2026-06-17 /srv/prime-silo-data
```

---

## Troubleshooting

### Command not found

Make sure you're in the Prime-Silo project root and have installed dependencies:

```bash
cd prime-silo
npm ci --prefix server
cd runtime && pip install -e . && cd ..
```

### Permission denied

Check that you have write access to `CUSTOMWARE_PATH` and can create files there.

### Connection refused

Make sure the server is running: `node space serve` and check the port is not blocked by firewall.

### Manifest errors

Validate manifests before running:

```bash
benny pypes inspect manifests/your_manifest.json
```

---

## See Also

- [QUICKSTART-EXE.md](QUICKSTART-EXE.md) — Desktop app quick start
- [GUIDE.md](GUIDE.md) — User interface walkthrough
- [HOME-DIRECTORY.md](HOME-DIRECTORY.md) — Workspace configuration
- [AGENTS.md](AGENTS.md) — Architecture and contracts

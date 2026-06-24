# Prime-Silo Agent Awareness Guide

> For AI agents operating within Prime-Silo

## System Overview for Agents

Prime-Silo is a deterministic execution platform with two core zones:

| Zone               | Purpose                                           | Agent Authority                           |
| ------------------ | ------------------------------------------------- | ----------------------------------------- |
| **Deterministic**  | Manifest execution, KG/code mutation, run lineage | Read-only (draft → HITL → sign → execute) |
| **Review/Sandbox** | Post-run analysis, composed layouts, agent drafts | Read + write to `agent_sandbox/`          |

Your agent operates in both zones. Be aware of the boundary.

---

## How to Discover System State

### Home Directory Configuration

Query where workspace data lives:

**Electron (Desktop App):**

```javascript
const { homeDir } = await ipcRenderer.invoke("space-desktop:get-home-directory");
console.log("Workspace root:", homeDir);
// Returns: { homeDir: "/home/user/prime-silo-workspace" } or null
```

**Returned value:**

- If set: absolute path to the workspace root
- If null: no home directory configured yet

---

## Core System Components

### 1. Workspace Structure

Every workspace follows this layout:

```
<CUSTOMWARE_PATH>/
├── config/                       # Configuration files
│   └── prime-silo.config.json   # Main config (settings, API keys)
├── L1/<group>/                  # Shared group data
│   ├── modules/                 # Installed modules
│   ├── manifests/               # Shared manifests
│   └── data/                    # Shared datasets
├── L2/<user>/                   # User personal data
│   ├── workspace/               # Working files
│   ├── modules/                 # Personal modules
│   ├── drafts/                  # Work-in-progress
│   └── pinned/                  # Saved views (.aamp.view files)
├── agent_sandbox/               # Agent sandbox (where you can write)
│   ├── views/                   # Agent-composed views (draft)
│   ├── notes/                   # Agent notes
│   ├── drafts/                  # Agent drafts
│   └── skills/                  # Agent skill implementations
├── runs/                        # Run history and logs
│   └── <run_id>/               # Individual run artifacts
└── apps.lock.json              # Service registry (Memo-Ray, etc.)
```

**Your sandbox:** Only write to `agent_sandbox/*`. Mutations elsewhere need human approval via signing.

### 2. Key File Paths

**Configuration:**

- `config/prime-silo.config.json` — Main config (read-only, humans edit this)
- `config/.env` — Environment variables (read-only during execution)

**Manifests:**

- `L1/<group>/manifests/` — Shared workflow definitions (deterministic zone)
- `L2/<user>/manifests/` — Personal manifests

**Runs:**

- `runs/<run_id>/` — Output from a specific manifest execution
- `runs/<run_id>/manifest.json` — Manifest that was executed
- `runs/<run_id>/lineage.json` — CLP lineage and audit trail

**Views:**

- `L2/<user>/pinned/*.aamp.view` — Signed, pinned views (human-approved)
- `agent_sandbox/views/*.draft.view` — Your draft views (unsigned)

---

## Querying System State

### Configuration

Read workspace configuration:

```javascript
// In the browser or Node.js context
const config = await fetch("/api/config").then((r) => r.json());

// Returns:
// {
//   workspace: "default",
//   customware_path: "/home/user/prime-silo-workspace",
//   host: "127.0.0.1",
//   port: 3000,
//   benny_url: "http://127.0.0.1:8005",
//   memoray_base_url: "http://127.0.0.1:3001",
//   ...
// }
```

### Available Manifests

List registered manifests (deterministic zone):

```bash
# Via CLI
node space registry

# Via API
fetch("/api/manifests").then(r => r.json())

# Returns: array of { id, name, version, description, ... }
```

### Run History

Query previous runs:

```bash
# Via CLI
benny runs ls --limit 10 --workspace default

# Via API
fetch("/api/runs?workspace=default&limit=10").then(r => r.json())

# Returns: array of run objects with { run_id, manifest, status, created_at, ... }
```

### Memory Graph Status

Check if Memo-Ray (session memory) is connected:

```bash
# Via CLI
node space memory status

# Via API
fetch("/api/integration_audit?service=memoray").then(r => r.json())

# Returns: { service: "memoray", connected: true/false, url: "...", ... }
```

### Bridge Status

Check if Bridge cockpit is available:

```bash
# Via CLI
node space bridge status

# Via API
fetch("/api/integration_audit?service=bridge").then(r => r.json())
```

---

## Agent Actions You Can Take

### 1. Read System Data

✅ **You can:**

- Read manifests from `L1/<group>/manifests/` and `L2/<user>/manifests/`
- Read previous runs from `runs/<run_id>/`
- Query run history via `/api/runs`
- Access configuration via `/api/config`
- Read the knowledge graph via `/api/graph/*` endpoints
- Inspect code graph via `/api/codegraph/*` endpoints
- Query session history via `node space memory search`
- Read your draft views from `agent_sandbox/views/`

### 2. Create Drafts (Non-Deterministic)

✅ **You can:**

- Write draft views to `agent_sandbox/views/*.draft.view`
- Write notes to `agent_sandbox/notes/`
- Create draft manifests in `agent_sandbox/drafts/manifests/`
- Write analysis and reports to `agent_sandbox/drafts/`

**Format for views:**

```json
{
  "format": "aamp.view/1",
  "title": "My Draft Analysis",
  "panels": [...],
  "signature": null,
  "created_at": "2026-06-17T...",
  "created_by": "agent-name"
}
```

**Note:** Drafts are unsigned. Only humans can pin/sign them via `/api/views/pin`.

### 3. Query Historical Context

✅ **You can:**

- List all sessions: `node space memory sessions`
- Search for sessions: `node space memory search <query>`
- Get full session context via `/api/lifelog?session=<id>`
- Inspect lineage: `node space runs inspect <run_id>`

### 4. Plan New Manifests (Advisory)

✅ **You can:**

- Generate manifests via AI: `benny pypes plan "<requirement>"`
- Save drafts: `benny pypes plan "..." --save` (goes to drafts, not execution)
- These are **advisory only**—no execution until human signs

### 5. Analyze Runs (Advisory)

✅ **You can:**

- Generate reports: `benny pypes agent-report <run_id>` (Markdown, advisory)
- Drill down into results: `benny pypes drilldown <run_id> <stage>`
- Create post-run analyses in your sandbox

---

## Actions You Cannot Take

❌ **You cannot:**

- Execute manifests directly (`benny run` / `benny pypes run`) — only humans can
- Mutate files in `L1/` or `L2/` directly — requires human approval + signing
- Modify `config/prime-silo.config.json` — only humans can
- Delete or modify run history (`runs/` directory) — audit trail is immutable
- Sign views/manifests (only humans via HMAC key can sign)
- Modify pinned views (`.aamp.view` files with valid signatures)
- Write outside `agent_sandbox/` directory
- Make mutations without recording lineage

---

## Important Contracts

### Lineage and Audit

Every mutation is logged:

- Deterministic zone: manifest runs produce `runs/<run_id>/lineage.json` with full CLP lineage
- Sandbox zone: your drafts record `created_at`, `created_by`, `created_from` (parent run/view)
- Query via: `node space memory audit` or `/api/integration_audit`

**Always include context when you create drafts:**

```json
{
  "created_from_run": "abc123",
  "created_from_panel": "run.reasoning_trace",
  "analysis_type": "risk_assessment",
  "confidence": 0.95,
  "reasoning": "..."
}
```

### Signing and Trust

- **Unsigned drafts** = advisory, not executable
- **Signed views** = approved by human, HMAC-verified, deterministic replay
- **To pin a view:** human clicks "Save & Sign" in UI → `/api/views/pin/<workspace>/<filename>`
- **To verify a pinned view:** `GET /api/views/load/<workspace>/<filename>` returns `{ view, signature, valid }`

### Deterministic Zone Boundaries

**You cannot write to:**

- Any manifest in `L1/*/manifests/` (deterministic zone)
- `runs/` directory (immutable audit trail)
- `config/` files (human-controlled)

**You can only:**

- Read from deterministic zone
- Write drafts to `agent_sandbox/`
- Generate advisory outputs (reports, analyses)
- Recommend human actions

---

## API Endpoints for Agents

### Configuration

```
GET /api/config                   # Runtime configuration
GET /api/config_defaults          # Default config values
GET /api/integration_audit        # Check service integrations
```

### Manifests and Runs

```
GET /api/manifests                # List registered manifests
GET /api/runs                      # List runs (with filters)
GET /api/runs/<run_id>            # Get specific run details
GET /api/runs/<run_id>/lineage    # Get run lineage (CLP)
POST /api/runs/<run_id>/drilldown # Drill into results
```

### Views and Layouts

```
GET /api/views/<workspace>        # List views
GET /api/views/load/<ws>/<file>   # Load view with signature validation
POST /api/views/pin/<ws>/<file>   # Sign and pin a view (human action)
```

### Graphs

```
GET /api/graph/search             # Search knowledge graph
GET /api/graph/nodes              # Get graph nodes
GET /api/codegraph/files          # List code files
GET /api/codegraph/canvas         # Get code graph visualization
```

### Memory and History

```
GET /api/lifelog                  # Activity feed (sessions, artifacts, commits)
GET /api/lifelog?session=<id>     # Get specific session context
```

---

## IPC (Electron Desktop App)

If running in the Electron desktop app, you can access:

### Home Directory Query

```javascript
// Get configured home directory
const { homeDir } = await ipcRenderer.invoke("space-desktop:get-home-directory");

// Example response
if (homeDir) {
  console.log("Workspace is at:", homeDir);
  // Can now resolve paths like: ${homeDir}/runs, ${homeDir}/L2/<user>/...
} else {
  console.log("Home directory not configured");
}
```

---

## Skills and Tool Integration

### benny-pilot Skill

The `benny-pilot` skill is available to agents for:

- Querying manifest registry
- Inspecting run lineage
- Accessing code graph
- Planning new manifests
- Generating analyses

Load it:

```javascript
const bennyPilot =
  await import("/mod/_prime_silo/memoray_client/ext/skills/benny-pilot/benny-pilot.js");
// Use: await bennyPilot.queryManifests(), etc.
```

### Memory-Recall Skill

Query session history:

```javascript
const recall =
  await import("/mod/_prime_silo/memoray_client/ext/skills/memory-recall/memory-recall.js");
// Use: await recall.search(query)
```

---

## Best Practices for Agents

1. **Always record context** — When you create a draft, explain where it came from
2. **Verify integration status** — Check if Memo-Ray and Bridge are available before using them
3. **Query workspace structure** — Use `/api/config` to know where home directory is
4. **Respect zone boundaries** — Read from deterministic zone, write to sandbox only
5. **Reference runs, not raw data** — Always link back to the run that generated your analysis
6. **Recommend, don't execute** — Suggest actions for humans to approve/sign
7. **Check permissions** — Query `/api/integration_audit` to know what's available

---

## Example: Complete Agent Workflow

```javascript
// 1. Check system state
const config = await fetch("/api/config").then(r => r.json());
const { homeDir } = await ipcRenderer.invoke("space-desktop:get-home-directory");
console.log("Working in:", homeDir);

// 2. Find relevant run
const runs = await fetch("/api/runs?limit=5").then(r => r.json());
const lastRun = runs[0];
console.log("Analyzing run:", lastRun.run_id);

// 3. Get lineage and context
const lineage = await fetch(`/api/runs/${lastRun.run_id}/lineage`)
  .then(r => r.json());

// 4. Generate analysis (advisory)
const analysis = {
  run_id: lastRun.run_id,
  findings: [...],
  recommendations: [...]
};

// 5. Write to sandbox
await fetch("/api/files/agent_sandbox/drafts/analysis.json", {
  method: "POST",
  body: JSON.stringify(analysis)
});

// 6. Create draft view (unsigned)
const draftView = {
  format: "aamp.view/1",
  title: `Analysis of ${lastRun.run_id}`,
  created_from_run: lastRun.run_id,
  panels: [...]
};

await fetch("/api/files/agent_sandbox/views/analysis.draft.view", {
  method: "POST",
  body: JSON.stringify(draftView)
});

// 7. Notify user
console.log("Draft analysis saved to agent_sandbox/views/analysis.draft.view");
console.log("Waiting for human to review and sign...");
```

---

## See Also

- [HOME-DIRECTORY.md](HOME-DIRECTORY.md) — Workspace directory structure and file locations
- [CLI.md](CLI.md) — Command-line tools available to agents
- [AGENTS.md](AGENTS.md) — Architecture and documentation contracts
- `/app/L0/_all/mod/_core/documentation/docs/` — Detailed API and feature documentation

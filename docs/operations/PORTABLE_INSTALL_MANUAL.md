# Benny Portable Install — Operations Manual

**Drive:** `F:\optimus` (or whatever letter this drive mounts as)
**BENNY_HOME:** `<drive>\optimus\home`
**Last updated:** 2026-04-27

---

## Contents

1. [What's on this drive](#1-whats-on-this-drive)
2. [First-time install](#2-first-time-install)
3. [Daily use — no PATH required](#3-daily-use--no-path-required)
4. [Environment variables — complete reference](#4-environment-variables--complete-reference)
5. [Managing env vars per machine](#5-managing-env-vars-per-machine)
6. [Drive letter changed? — relocation](#6-drive-letter-changed--relocation)
7. [Updating benny](#7-updating-benny)
8. [Services: what runs where](#8-services-what-runs-where)
9. [Offline / local-only mode](#9-offline--local-only-mode)
10. [Adding another machine](#10-adding-another-machine)
11. [Troubleshooting](#11-troubleshooting)
12. [Hybrid setup — models and Docker on C:, workspaces on F:](#12-hybrid-setup--models-and-docker-on-c-workspaces-on-f)
13. [NVIDIA NIM — cloud GPU inference](#13-nvidia-nim--cloud-gpu-inference)

---

## 1. What's on this drive

```
F:\optimus\
├── install.ps1           ← Run once to bootstrap. Safe to re-run.
├── benny.cmd             ← Root launcher — works at any drive letter.
├── MANUAL.md             ← This file.
│
├── runtime\
│   └── python\           ← Self-contained Python 3.11 (no C: dependency).
│
├── code\
│   └── benny\            ← Benny source code (editable pip install).
│       ├── benny/        ← Python package
│       ├── tests/
│       ├── manifests/
│       ├── schemas/
│       └── ...
│
└── home\                 ← BENNY_HOME — all user data lives here.
    ├── bin\              ← Launcher shims (benny.cmd, benny-llm.cmd, …)
    ├── config\
    │   └── benny.toml    ← Ports, profile, timeouts. Edit this for config.
    ├── workspaces\       ← Your workspaces (survives reinstall).
    ├── workflows\        ← Signed manifest JSONs.
    ├── runs\             ← Run history (SQLite).
    ├── logs\             ← Per-service logs + llm_calls.jsonl.
    ├── models\           ← Local LLM weights (large; git-ignored).
    ├── state\
    │   ├── device-id     ← UUID minted at first init.
    │   └── profile-lock  ← "native" — records the profile choice.
    └── runtime\          ← (native profile) neo4j/, lemonade/ binaries go here.
        ├── lemonade\     ← Drop LemonadeServer.exe here for offline LLM.
        ├── neo4j\        ← Drop portable Neo4j here if not using Docker.
        └── node\         ← Node.js runtime if needed.
```

---

## 2. First-time install

Run **once** from PowerShell:

```powershell
powershell -ExecutionPolicy Bypass -File F:\optimus\install.ps1
```

**Prerequisites on the host machine:**
- Windows 10/11
- Conda (miniconda or miniforge) — used once to create the Python env, then never needed again
- Git (optional — only needed to pull updates later)
- Docker Desktop (optional — only needed for Neo4j / Marquez / Phoenix services)

**What the script does:**
1. Creates `F:\optimus\runtime\python\` — portable Python 3.11 via `conda create --prefix`
2. Copies benny code → `F:\optimus\code\benny\` (skips `node_modules`, `.git`, `workspace` data)
3. `pip install -e F:\optimus\code\benny[dev,mcp]` into the portable Python
4. `benny init --home F:\optimus\home --profile native` — scaffolds BENNY_HOME
5. Writes `F:\optimus\benny.cmd` — the root launcher
6. Sets `BENNY_HOME=F:\optimus\home` as a user-level env var

**After install, verify:**
```
F:\optimus\benny.cmd doctor
```

---

## 3. Daily use — no PATH required

The root launcher `F:\optimus\benny.cmd` self-locates Python and BENNY_HOME
from its own path on disk. You never need to set PATH or activate any environment.

```batch
rem ── Start the full stack ───────────────────────────────────
F:\optimus\benny.cmd up

rem ── Check status ───────────────────────────────────────────
F:\optimus\benny.cmd status
F:\optimus\benny.cmd doctor
F:\optimus\benny.cmd doctor --json

rem ── Plan and run ───────────────────────────────────────────
F:\optimus\benny.cmd plan "Summarise PDFs in data_in/" --workspace myws --save
F:\optimus\benny.cmd run manifests\latest.manifest.json --json
F:\optimus\benny.cmd runs ls --limit 10

rem ── Pypes transformation pipeline ─────────────────────────
F:\optimus\benny.cmd pypes run manifests\templates\financial_risk_pipeline.json --workspace pypes_demo
F:\optimus\benny.cmd pypes drilldown <run_id> gold_exposure --workspace pypes_demo

rem ── AOS-001 SDLC pipeline ─────────────────────────────────
F:\optimus\benny.cmd req "Add payment retry logic" --workspace myws --save
F:\optimus\benny.cmd run manifests\sdlc_pipeline.json --json

rem ── Stop the stack ─────────────────────────────────────────
F:\optimus\benny.cmd down
```

**Tip — add a shortcut for this session only (no permanent PATH change):**
```batch
doskey benny=F:\optimus\benny.cmd $*
benny status
benny doctor
```

**Or permanently add to PATH for this user (optional):**
```powershell
# PowerShell — adds F:\optimus to user PATH (survives reboot)
$old = [Environment]::GetEnvironmentVariable("PATH","User")
[Environment]::SetEnvironmentVariable("PATH","$old;F:\optimus","User")
```
After that you can just type `benny` from any directory.

---

## 4. Environment variables — complete reference

These are all env vars Benny reads, in priority order from most to least essential.

### 4.1 Core

| Variable | Default | What it does |
|----------|---------|-------------|
| `BENNY_HOME` | *(none — must be set)* | Root of the portable home directory. The root launcher sets this automatically from its own path. Only set this manually if running `python -m benny_cli` directly without the launcher. |

### 4.2 LLM / Model

| Variable | Default | What it does |
|----------|---------|-------------|
| `BENNY_OFFLINE` | `""` (cloud allowed) | Set to `1`, `true`, or `yes` to block **all** cloud LLM calls. Any call to a cloud provider raises `OfflineRefusal`. Local providers (Lemonade, Ollama) still work. Use this on planes, air-gapped machines, or customer demos. |
| `BENNY_DEFAULT_MODEL` | *(from workspace config)* | Override the default model for `pypes chat`, `pypes agent-report`, and `pypes plan`. Example: `BENNY_DEFAULT_MODEL=lm_studio/llama-3-8b`. |
| `BENNY_LLM_TIMEOUT` | `300` (seconds) | Hard timeout on any LLM HTTP call. Raise for large-document passes; lower for latency-sensitive pipelines. |
| `BENNY_LEMONADE_BASE` | `http://127.0.0.1:13305/api/v1` | Base URL of the Lemonade local LLM server. Change if you run Lemonade on a non-standard port or remote host. |
| `BENNY_OLLAMA_BASE` | `http://127.0.0.1:11434` | Base URL of an Ollama instance. |
| `OPENAI_API_KEY` | `""` | OpenAI API key for cloud synthesis tasks in `benny/synthesis/engine.py`. Leave unset for fully offline operation. |

### 4.3 API server

| Variable | Default | What it does |
|----------|---------|-------------|
| `BENNY_API_PORT` | `8000` | Port the FastAPI backend listens on. Also used by the MCP server and doctor health probe. Change if 8000 is already taken on the host. |
| `BENNY_REQUIRE_SIGNATURES` | `""` (off) | Set to `1` or `true` to make the API reject unsigned manifests. Recommended for production; off by default to ease development. |

**HTTP API key** (not an env var — passed as a request header):

```
X-Benny-API-Key: benny-mesh-2026-auth
```

This header is required on every API call except the whitelisted paths (`/`, `/api/health`, `/docs`, SSE streams, `/.well-known/agent.json`). The value is fixed in this release; see `benny/api/server.py` to customise it.

### 4.4 Neo4j

| Variable | Default | What it does |
|----------|---------|-------------|
| `NEO4J_URI` | `bolt://localhost:7687` | Neo4j bolt connection URI. If running Neo4j via Docker Compose change to `bolt://neo4j:7687` (service name). |
| `NEO4J_USER` | `neo4j` | Neo4j username. |
| `NEO4J_PASSWORD` | `password` | Neo4j password. Change this in `F:\optimus\home\config\benny.toml` and here for any production use. |

### 4.5 Security / HMAC

| Variable | Default | What it does |
|----------|---------|-------------|
| `BENNY_HMAC_KEY` | *(dev fallback key)* | Hex-encoded 32-byte secret used to HMAC-SHA256 sign checkpoint payloads and the AOS audit ledger. **MUST be set in production.** If not set, benny uses a hardcoded dev key — safe on a local drive, dangerous on a shared server. Generate with: `python -c "import secrets; print(secrets.token_hex(32))"`. |
| `BENNY_VAULT_KEY` | `""` | Encryption key for `benny/gateway/credential_vault.py`. Only needed if you store credentials (API keys, passwords) in the vault. |

### 4.6 Storage

| Variable | Default | What it does |
|----------|---------|-------------|
| `BENNY_SQLITE_PATH` | `workspace/.benny/checkpoints.db` | Path to the SQLite checkpoint database (relative to the current workspace). Rarely needs changing. |
| `BENNY_POSTGRES_URL` | `""` | Optional PostgreSQL connection string for checkpoint storage. Leave unset to use SQLite (recommended for local/portable use). |

### 4.7 Pypes tuning

| Variable | Default | What it does |
|----------|---------|-------------|
| `BENNY_PYPES_FACTS_CHAR_BUDGET` | `5000` | Max characters of gold-table facts loaded into the `pypes chat` / `pypes agent-report` context window per turn. Raise for richer answers, lower for faster/cheaper calls. |
| `BENNY_PYPES_CHAT_MAX_TOKENS` | `800` | Max completion tokens per `pypes chat` response turn. |
| `BENNY_COMPUTE_COST_USD_PER_HOUR` | `0.20` | Assumed USD/hour for compute cost in `pypes bench` and `pypes model-bench` reports. |

### 4.8 AOS-001 SDLC

| Variable | Default | What it does |
|----------|---------|-------------|
| `BENNY_VRAM_BUDGET_MB` | *(auto-detected from GPU)* | Total VRAM budget in MB for the VRAM-aware worker pool. Benny tries to detect this automatically; set explicitly if detection is wrong or you want to reserve headroom. |

---

## 5. Managing env vars per machine

### 5.1 The launcher always handles BENNY_HOME

`F:\optimus\benny.cmd` sets `BENNY_HOME` and PATH from its own location every
time it runs. **You do not need to set `BENNY_HOME` manually** when using the
launcher. The only reason to set it is if you call `python -m benny_cli` directly.

### 5.2 Machine-persistent vars (survive reboot)

Set these once per machine using PowerShell (user-level, no admin required):

```powershell
# --- Essential ----------------------------------------------------------
# Only needed if you want `benny` on your PATH without the full path prefix.
# Skip this if you're happy using F:\optimus\benny.cmd directly.
$old = [Environment]::GetEnvironmentVariable("PATH","User")
[Environment]::SetEnvironmentVariable("PATH","$old;F:\optimus","User")

# --- Security (production) -----------------------------------------------
# Generate a strong key once per machine and store it here:
$key = python -c "import secrets; print(secrets.token_hex(32))"
[Environment]::SetEnvironmentVariable("BENNY_HMAC_KEY", $key, "User")

# --- LLM provider base URLs (only if non-default) -----------------------
[Environment]::SetEnvironmentVariable("BENNY_LEMONADE_BASE","http://127.0.0.1:13305/api/v1","User")
[Environment]::SetEnvironmentVariable("BENNY_OLLAMA_BASE","http://127.0.0.1:11434","User")

# --- Cloud API keys (only if you use cloud LLMs) ------------------------
[Environment]::SetEnvironmentVariable("OPENAI_API_KEY","sk-...","User")

# --- Verify (new shell needed to see changes, but this works inline) ----
[Environment]::GetEnvironmentVariable("BENNY_HOME","User")
```

**To delete a var:**
```powershell
[Environment]::SetEnvironmentVariable("BENNY_OFFLINE", $null, "User")
```

**To see all current user env vars:**
```powershell
[Environment]::GetEnvironmentVariables("User").GetEnumerator() |
    Where-Object { $_.Key -like "BENNY*" -or $_.Key -like "NEO4J*" } |
    Sort-Object Key | Format-Table -AutoSize
```

### 5.3 Session-only vars (this shell only, gone on close)

```batch
rem CMD
set BENNY_OFFLINE=1
set BENNY_LLM_TIMEOUT=600
F:\optimus\benny.cmd run manifests\big_pipeline.json
set BENNY_OFFLINE=
```

```powershell
# PowerShell
$env:BENNY_OFFLINE = "1"
F:\optimus\benny.cmd run manifests\big_pipeline.json --json
$env:BENNY_OFFLINE = ""
```

### 5.4 Project-scoped vars via `.env` file (recommended pattern)

For per-workspace overrides, create a `.env` file next to your manifest and
load it at the start of a session. Benny does **not** auto-load `.env` files —
you load them explicitly, keeping side effects visible:

```powershell
# Load a .env file in PowerShell (simple parser, skips comments)
Get-Content ".env" | ForEach-Object {
    if ($_ -match "^\s*([^#][^=]+)=(.*)$") {
        [Environment]::SetEnvironmentVariable($matches[1].Trim(), $matches[2].Trim(), "Process")
    }
}
```

Example `.env` for an offline customer demo:
```
BENNY_OFFLINE=1
BENNY_DEFAULT_MODEL=lm_studio/llama-3-8b
BENNY_LLM_TIMEOUT=600
BENNY_HMAC_KEY=<your-key-here>
NEO4J_PASSWORD=<your-neo4j-password>
```

> **Never commit `.env` files to git.** Add `.env` to `.gitignore`.

### 5.5 Viewing effective config

`benny doctor --json` shows the live resolved values of every setting:
```
F:\optimus\benny.cmd doctor --json
```

The output includes an `aos` section (added by AOS-001) with PBR store size,
ledger head SHA, and pending HITL count:
```json
{
  "benny_home": "F:\\optimus\\home",
  "offline": false,
  "api_port": 8000,
  "aos": {
    "pbr_store_size_bytes": 0,
    "ledger_head_sha": null,
    "pending_hitl_count": 0
  }
}
```

---

## 6. Drive letter changed? — relocation

If the drive mounts as `E:\` instead of `F:\` on another machine, the launcher
self-adjusts automatically — **no action needed** for the launcher itself.

However, any signed manifests you created on `F:\` have `F:\optimus\home`
baked into their paths. Fix them with the migrate command:

```batch
rem From the new drive letter (e.g. E:)
E:\optimus\benny.cmd migrate --from F:\optimus\home --to E:\optimus\home --dry-run
rem review output, then apply:
E:\optimus\benny.cmd migrate --from F:\optimus\home --to E:\optimus\home --apply
```

`benny migrate` (implemented in `benny/migrate/importer.py`):
1. Walks the source tree, rewrites absolute host paths in JSON / manifest / config files to `${BENNY_HOME}` tokens.
2. **Re-signs** every rewritten manifest (HMAC-SHA256 via `benny/core/manifest_hash.py`).
3. Emits a report: `rewrites=N`, per-file actions, errors.

**Always run `--dry-run` first.**

If BENNY_HOME was set as a user env var on the old machine, update it:
```powershell
[Environment]::SetEnvironmentVariable("BENNY_HOME","E:\optimus\home","User")
```
(The launcher sets it from its own path anyway — this is only for direct CLI use.)

---

## 7. Updating benny

```batch
rem Pull new code (requires Git on PATH, or use GitHub Desktop / VS Code)
cd F:\optimus\code\benny
git fetch origin
git merge origin/master

rem Re-install dependencies if pyproject.toml changed
F:\optimus\runtime\python\python.exe -m pip install -e "F:\optimus\code\benny[dev,mcp]" --quiet

rem Re-init the home (idempotent — safe to run on an existing home)
F:\optimus\benny.cmd init --home F:\optimus\home --profile native

rem Verify all release gates still pass
F:\optimus\runtime\python\python.exe -m pytest F:\optimus\code\benny\tests\release -q
```

If schema version changed, benny will tell you to run `benny migrate`.

---

## 8. Services: what runs where

| Service | Default port | Where to install | Docker? |
|---------|-------------|-----------------|---------|
| **Benny API** (FastAPI) | 8000 | Runs from `F:\optimus\code\benny\` | No — pure Python |
| **Benny UI** (React / Vite) | 5173 | Runs from `F:\optimus\code\benny\frontend\` | No — `npm run dev` |
| **Lemonade** (local LLM) | 13305 | Drop `LemonadeServer.exe` → `F:\optimus\home\runtime\lemonade\` | No |
| **Ollama** | 11434 | Install on host or run from drive if portable build available | No |
| **Neo4j** | 7474 / 7687 | Docker Compose (recommended) OR portable community edition → `F:\optimus\home\runtime\neo4j\` | Optional |
| **Marquez** (OpenLineage) | 3010 | Docker Compose only | Yes |
| **Phoenix** (OTLP tracing) | 6006 | Docker Compose only | Yes |

**To start only the Python API (no Docker needed):**
```batch
F:\optimus\benny.cmd up --only api
```

**To start everything including Docker services:**
```batch
F:\optimus\benny.cmd up
```

### 8.1 Lemonade — drop-in offline LLM

1. Download `LemonadeServer.exe` from the AMD Lemonade releases page.
2. Drop it into `F:\optimus\home\runtime\lemonade\`.
3. The `benny-llm.cmd` launcher in `F:\optimus\home\bin\` will pick it up.
4. Start with: `F:\optimus\home\bin\benny-llm.cmd`
5. Then: `F:\optimus\benny.cmd up --only api`

**Port override** (if 13305 is taken):
```toml
# F:\optimus\home\config\benny.toml
[runtime]
lemonade_port = 13306
```
And set the matching env var:
```powershell
[Environment]::SetEnvironmentVariable("BENNY_LEMONADE_BASE","http://127.0.0.1:13306/api/v1","User")
```

---

## 9. Offline / local-only mode

For planes, air-gapped machines, or customer demos:

```batch
rem Session-only:
set BENNY_OFFLINE=1
F:\optimus\benny.cmd up --only api
F:\optimus\benny.cmd plan "..." --workspace demo --save

rem Or permanent for this machine:
powershell -Command "[Environment]::SetEnvironmentVariable('BENNY_OFFLINE','1','User')"
```

In offline mode:
- All cloud LLM calls raise `OfflineRefusal` immediately (no hang, no spend).
- Lemonade and Ollama continue to work normally.
- The AOS-001 SDLC pipeline, PBR store, ledger, and policy gate all function offline.
- `benny doctor` shows `"offline": true` in its JSON output.

**To return to online mode:**
```batch
set BENNY_OFFLINE=
```
or delete the user env var:
```powershell
[Environment]::SetEnvironmentVariable("BENNY_OFFLINE", $null, "User")
```

---

## 10. Adding another machine

On a new Windows machine with this drive plugged in as (for example) `E:\`:

1. **Run the install script** — it re-creates the Python env on this machine if needed:
   ```powershell
   powershell -ExecutionPolicy Bypass -File E:\optimus\install.ps1
   ```
   The script detects existing dirs and skips already-complete steps.

2. **Verify:**
   ```
   E:\optimus\benny.cmd doctor
   ```

3. **Set machine-specific secrets** (each machine should have its own HMAC key):
   ```powershell
   $key = E:\optimus\runtime\python\python.exe -c "import secrets; print(secrets.token_hex(32))"
   [Environment]::SetEnvironmentVariable("BENNY_HMAC_KEY", $key, "User")
   ```

4. **If the drive letter is different**, run migrate (see §6).

> **What carries across machines automatically:**
> workspaces, manifests, run history, logs, models, config.toml, device-id.
>
> **What is machine-specific:**
> `BENNY_HMAC_KEY`, any cloud API keys, port bindings (if changed),
> Docker Desktop installation.

---

## 11. Troubleshooting

### `benny.cmd` says "Python not found"

The `runtime\python\` dir is missing or was installed for a different drive
letter. Re-run `install.ps1`:
```powershell
powershell -ExecutionPolicy Bypass -File F:\optimus\install.ps1
```

### `benny doctor` shows `BENNY_HOME: MISSING`

You're running `python -m benny_cli` directly (not through the launcher), and
`BENNY_HOME` is not set in your shell. Either use the launcher or:
```batch
set BENNY_HOME=F:\optimus\home
python -m benny_cli doctor
```

### Port already in use

```batch
F:\optimus\benny.cmd status
```
Shows which services are alive. Kill the stale process, then change the port in
`F:\optimus\home\config\benny.toml` and set the matching env var.

| If port | Var to change | toml key |
|---------|--------------|----------|
| 8000 | `BENNY_API_PORT` | `[runtime] api_port` |
| 13305 | `BENNY_LEMONADE_BASE` | `[runtime] lemonade_port` |
| 7687 | `NEO4J_URI` | `[runtime] neo4j_bolt_port` |

### `OfflineRefusal` on every call (unexpected)

```powershell
[Environment]::GetEnvironmentVariable("BENNY_OFFLINE","User")
[Environment]::GetEnvironmentVariable("BENNY_OFFLINE","Process")
```
If either returns `1`, clear it:
```powershell
[Environment]::SetEnvironmentVariable("BENNY_OFFLINE", $null, "User")
```

### Manifest signature invalid after moving drives

Run `benny migrate` (see §6). Manifests embed the absolute path of BENNY_HOME
at signing time; migrate re-signs them with the new path.

### `Governance violation: Invalid or missing X-Benny-API-Key`

Any direct HTTP call to the API needs the key header:
```
curl -H "X-Benny-API-Key: benny-mesh-2026-auth" http://127.0.0.1:8000/api/health
```

### Checkpoint HMAC mismatch warning

The ledger or checkpoint HMAC chain failed verification. This means either:
- `BENNY_HMAC_KEY` is different from the key used when the chain was written.
- Someone tampered with `F:\optimus\home\data\ledger.jsonl`.

Fix: verify the key is consistent:
```batch
F:\optimus\benny.cmd doctor --audit
```

---

## Quick reference card

```
┌─────────────────────────────────────────────────────────────────┐
│  Benny Portable — Quick Reference                               │
├─────────────────────────────────────────────────────────────────┤
│  LAUNCHER (no PATH needed)                                      │
│    F:\optimus\benny.cmd <command>                               │
│                                                                 │
│  KEY COMMANDS                                                   │
│    up / down / status / doctor                                  │
│    plan "<req>" --workspace <ws> --save                         │
│    run <manifest.json> --json                                   │
│    runs ls --limit 10                                           │
│    pypes run <manifest> --workspace <ws>                        │
│    req "<req>" --workspace <ws> --save     (AOS BDD pipeline)   │
│                                                                 │
│  KEY ENV VARS                                                   │
│    BENNY_HOME        = F:\optimus\home  (auto-set by launcher)  │
│    BENNY_OFFLINE     = 1               (block cloud LLMs)       │
│    BENNY_HMAC_KEY    = <hex32>         (production MUST set)    │
│    BENNY_API_PORT    = 8000            (change if port clash)   │
│    NEO4J_PASSWORD    = <password>      (change from default)    │
│                                                                 │
│  SET A VAR (permanent, no admin):                               │
│    powershell -Command "[Environment]::SetEnvironmentVariable   │
│      ('BENNY_OFFLINE','1','User')"                              │
│                                                                 │
│  VIEW EFFECTIVE CONFIG:                                         │
│    F:\optimus\benny.cmd doctor --json                           │
│                                                                 │
│  DRIVE LETTER CHANGED?                                          │
│    <new>\optimus\benny.cmd migrate --from <old>\optimus\home   │
│      --to <new>\optimus\home --dry-run   then --apply           │
└─────────────────────────────────────────────────────────────────┘
```

---

## 12. Hybrid setup — models and Docker on C:, workspaces on F:

The full portable install (§2) puts everything — Python, code, and data — on
this drive. If you prefer to keep Python, Docker images, and LLM model weights
on your laptop's C: drive and only store workspace data on this drive, that is
fully supported and actually simpler. This section explains how.

### 12.1 What lives where (by design)

Before choosing an option, it helps to know where Benny actually stores things:

| Item | Where it lives | Moveable? |
|------|---------------|-----------|
| Python / conda | `C:\Users\nsdha\miniconda3\` | Yes (but rarely worth it) |
| Benny source code | `C:\Users\nsdha\OneDrive\code\benny\` | Yes |
| Docker images | Docker's own data root (`C:\ProgramData\Docker\` or WSL2) | No — Docker controls this |
| LLM model weights | Lemonade: `C:\Users\nsdha\.lemonade\models\` — Ollama: `C:\Users\nsdha\.ollama\` | Yes, but requires reconfiguring the server |
| **BENNY_HOME** (workspaces, runs, logs, manifests, config) | Wherever `BENNY_HOME` points | **Yes — this is the key lever** |

The `models\` folder that `benny init` creates inside BENNY_HOME is a staging
hint only. Lemonade and Ollama store actual weights in their **own** directories
on C: — BENNY_HOME has nothing to do with that. Docker images always live in
Docker's data root, regardless of where BENNY_HOME is. So the only thing you
need to move is BENNY_HOME itself.

### 12.2 Option A — Minimal BENNY_HOME on F: (recommended)

Runtime (Python, Docker, models) stays on C:. Only the data home moves to F:.

```powershell
# Step 1 — ensure benny is installed on C: from your existing checkout
pip install -e "C:\Users\nsdha\OneDrive\code\benny[dev,mcp]"

# Step 2 — scaffold the data home on the external drive
python -m benny_cli init --home "F:\optimus\home" --profile native

# Step 3 — point benny at it permanently (user-level, no admin required)
[Environment]::SetEnvironmentVariable("BENNY_HOME", "F:\optimus\home", "User")
$env:BENNY_HOME = "F:\optimus\home"   # also apply to current shell

# Step 4 — verify
benny doctor
```

From this point on, every `benny` command on your PATH uses Python from
C:\miniconda3, Docker from C:, and Lemonade weights from C: — but writes all
workspace data, run history, logs, and manifests to `F:\optimus\home`.

**What happens when you unplug the drive:**
- The laptop boots normally.
- `benny doctor` reports `BENNY_HOME: MISSING` (drive not mounted).
- All other laptop software is unaffected.

**What happens when you plug the drive into a different machine:**
- The drive contains all your workspace data.
- That machine needs benny installed (`pip install -e ...`) and `BENNY_HOME` set.
- See §10 for the full multi-machine setup.

---

### 12.3 Option B — BENNY_HOME on C:, workspaces directory junctioned to F:

Use this when you already have a working C: install and want **only the
workspace data** folder redirected to F: without disturbing anything else.
A Windows directory junction makes `workspaces\` inside BENNY_HOME transparently
point to `F:\optimus\workspaces\`. Benny never knows the difference.

```powershell
# Step 1 — create the target directory on the external drive
New-Item -ItemType Directory -Force "F:\optimus\workspaces"

# Step 2 — remove the existing workspaces dir from BENNY_HOME
#           (skip if it is already empty or does not exist)
Remove-Item "$env:BENNY_HOME\workspaces" -Recurse -Force -ErrorAction SilentlyContinue

# Step 3 — create the junction (reads and writes go transparently to F:)
cmd /c mklink /J "$env:BENNY_HOME\workspaces" "F:\optimus\workspaces"

# Step 4 — verify — benny sees a normal directory
benny doctor
dir "$env:BENNY_HOME\workspaces"   # shows F:\optimus\workspaces contents
```

**What happens when you unplug the drive:**
- BENNY_HOME is intact on C: — benny starts normally.
- The `workspaces\` junction becomes a broken link; benny will create a fresh
  empty `workspaces\` on the next `benny init` or workspace access.
- No data is lost — everything is still on F:.

**To extend the junction to runs and logs as well:**
```powershell
foreach ($dir in @("runs", "logs", "workflows")) {
    New-Item -ItemType Directory -Force "F:\optimus\$dir"
    Remove-Item "$env:BENNY_HOME\$dir" -Recurse -Force -ErrorAction SilentlyContinue
    cmd /c mklink /J "$env:BENNY_HOME\$dir" "F:\optimus\$dir"
}
```

---

### 12.4 Comparison

| | Full portable (§2) | Option A — data home only | Option B — junction |
|--|-------------------|--------------------------|---------------------|
| BENNY_HOME | `F:\optimus\home` | `F:\optimus\home` | C: (unchanged) |
| Python | `F:\optimus\runtime\python\` | C: miniconda | C: miniconda |
| Docker images | C: Docker root | C: Docker root | C: Docker root |
| Model weights | C: Lemonade/Ollama dirs | C: Lemonade/Ollama dirs | C: Lemonade/Ollama dirs |
| Workspace data | `F:\optimus\home\workspaces\` | `F:\optimus\home\workspaces\` | `F:\optimus\workspaces\` (via junction) |
| Benny on PATH | `F:\optimus\benny.cmd` | C: `benny` (pip-installed) | C: `benny` (pip-installed) |
| Drive unplugged | laptop `benny` command gone | `BENNY_HOME: MISSING` warning | benny works, no workspace data |
| New machine setup | run `install.ps1` | `pip install` + set `BENNY_HOME` | `pip install` + recreate junction |
| Best for | maximum portability, demo drive | data isolation, keep C: setup | minimal disruption to existing install |

---

### 12.5 Checking where things actually are

At any time you can see the live resolved paths:

```powershell
# Where is BENNY_HOME right now?
[Environment]::GetEnvironmentVariable("BENNY_HOME","User")
$env:BENNY_HOME

# What is benny reporting?
benny doctor --json | python -m json.tool

# Is the workspaces dir a real dir or a junction?
(Get-Item "$env:BENNY_HOME\workspaces").LinkType   # prints "Junction" or empty

# Where are Lemonade weights?
Get-ChildItem "$env:USERPROFILE\.lemonade\models" -ErrorAction SilentlyContinue

# Where is Docker's data root?
docker info --format "{{.DockerRootDir}}" 2>$null
```

---

### 12.6 Updating the manual's quick reference card

The quick reference at the bottom of this manual reflects the full portable
setup (§2). For Option A or B, substitute the following in that card:

**Option A — data home on F:, runtime on C:**
```
LAUNCHER:  benny   (on PATH, installed to C:\miniconda3)
BENNY_HOME = F:\optimus\home   (set as user env var)
```

**Option B — junction:**
```
LAUNCHER:  benny   (on PATH, unchanged)
BENNY_HOME = C:\...\  (unchanged — junction handles the rest)
Junction:  BENNY_HOME\workspaces → F:\optimus\workspaces
```

---

## 13. NVIDIA NIM — cloud GPU inference

NVIDIA's NIM platform (`https://integrate.api.nvidia.com/v1`) provides
OpenAI-compatible access to hosted models — DeepSeek-R1, Llama 3.3, Mistral,
Gemma 3, and more — running on NVIDIA's cloud GPUs. Benny routes these through
the same `call_model()` dispatcher as every other provider.

### 13.1 Get an API key

1. Sign in at **https://build.nvidia.com**
2. Select any model → click **Get API Key** → create a new key
3. Your key starts with `nvapi-` followed by a long alphanumeric string

Keep it private — it is a billing credential. Benny's secrets scanner
(`benny/governance/portability/secrets_scanner.py`) will flag any `nvapi-…`
token it finds written into a file on disk or committed to git.

### 13.2 Store the key safely — three options

**Option 1 — User env var (recommended)**

Set once per machine. No admin rights required. Never written to disk in
plaintext inside BENNY_HOME.

```powershell
[Environment]::SetEnvironmentVariable("NVIDIA_API_KEY", "nvapi-xxxx", "User")
```

Benny reads `NVIDIA_API_KEY` automatically at call time. If it is missing,
`call_model()` logs a warning and the NIM call fails with an auth error — it
never silently falls back to a different provider.

> **Why env var and not a file?**
> An env var set at the user level lives only in the Windows registry
> (`HKEY_CURRENT_USER\Environment`) — not on the drive you hand to someone else,
> not in git, and not inside `F:\optimus`. If this drive is lost or stolen, the
> key is not on it.

**Option 2 — Benny credential vault (per-workspace)**

Use this when different workspaces need different NVIDIA keys, or when you want
every key access to be Fernet-encrypted and audit-logged.

```python
# Store (run once)
from benny.gateway.credential_vault import store_credential
store_credential("my_workspace", "nvidia_api_key", "nvapi-xxxx")

# Retrieve at call time
from benny.gateway.credential_vault import get_credential
key = get_credential("my_workspace", "nvidia_api_key")
```

The vault file lives at
`$BENNY_HOME/workspaces/my_workspace/credentials/vault.json`.
Values are Fernet-encrypted (AES-128-CBC). The vault is only as secure as
`BENNY_VAULT_KEY` — set that env var too:

```powershell
# Generate a strong vault key once per machine
$vk = python -c "import secrets; print(secrets.token_hex(32))"
[Environment]::SetEnvironmentVariable("BENNY_VAULT_KEY", $vk, "User")
```

Without `BENNY_VAULT_KEY`, the vault falls back to base64 (obfuscation only,
not encryption) — fine for local dev, not for production.

**Option 3 — Session-only (CI / scripts)**

```powershell
$env:NVIDIA_API_KEY = "nvapi-xxxx"
benny run manifests/my_manifest.json --json
$env:NVIDIA_API_KEY = ""     # clear immediately after
```

Never use this in a `.ps1` file committed to git.

### 13.3 What NOT to do

| ❌ Don't | Why |
|----------|-----|
| Put the key in `benny.toml` | Plaintext on disk; SR-3 scanner flags it; file may be committed |
| Put it directly in a manifest JSON | Manifests are signed and shared — the key travels with the file |
| Set `NVIDIA_API_KEY` as a system-level env var | Available to every process and every user on the machine |
| Commit a `.env` file containing the key | Ends up in git history even after deletion |
| Echo the key in a log or print statement | `logs/llm_calls.jsonl` is not encrypted |

### 13.4 Calling NVIDIA NIM models

Once `NVIDIA_API_KEY` is set, use the `nvidia/<org>/<model>` prefix anywhere
Benny accepts a model name:

**From Python (via `call_model`):**
```python
import asyncio
from benny.core.models import call_model

response = asyncio.run(call_model(
    model="nvidia/deepseek-ai/deepseek-r1",
    messages=[{"role": "user", "content": "Explain HMAC-SHA256"}],
    temperature=0.6,
    max_tokens=4096,
))
print(response)
```

**From the CLI:**
```batch
benny plan "Refactor the payment service" --model nvidia/deepseek-ai/deepseek-r1 --workspace myws --save
benny run manifests/latest.manifest.json --json
```

**In a manifest (model_per_persona):**
```json
{
  "schema_version": "1.1",
  "model_per_persona": {
    "planner":    "nvidia/deepseek-ai/deepseek-r1",
    "architect":  "nvidia/meta/llama-3.3-70b-instruct",
    "coder":      "local_lemonade"
  }
}
```
This lets you mix NVIDIA cloud models for planning with local models for
code generation — the offline kill-switch (`BENNY_OFFLINE=1`) will block
the nvidia calls but leave `local_lemonade` untouched.

### 13.5 Available models (built-in registry)

These are pre-registered in `benny/core/models.py`. Any other NIM model
from **https://build.nvidia.com** also works via the ad-hoc
`nvidia/<org>/<slug>` prefix.

| Benny model ID | NIM slug | Approx cost / 1 K tokens |
|----------------|----------|--------------------------|
| `nvidia/deepseek-ai/deepseek-r1` | `deepseek-ai/deepseek-r1` | $0.004 |
| `nvidia/deepseek-ai/deepseek-v3` | `deepseek-ai/deepseek-v3` | $0.0004 |
| `nvidia/meta/llama-3.3-70b-instruct` | `meta/llama-3.3-70b-instruct` | $0.00077 |
| `nvidia/mistralai/mistral-large-2-instruct` | `mistralai/mistral-large-2-instruct` | $0.002 |
| `nvidia/google/gemma-3-27b-it` | `google/gemma-3-27b-it` | $0.0002 |
| `nvidia/<org>/<any-nim-slug>` | ad-hoc — any model on build.nvidia.com | varies |

### 13.6 Reasoning / thinking models (DeepSeek-R1)

DeepSeek-R1 on NIM supports extended reasoning via `extra_body`. Benny passes
`extra_body` through to LiteLLM when you provide it via the manifest's
`task.extra` field or directly in a script:

```python
response = asyncio.run(call_model(
    model="nvidia/deepseek-ai/deepseek-r1",
    messages=[{"role": "user", "content": "Design a fault-tolerant ledger"}],
    temperature=1.0,
    max_tokens=16384,
    # extra_body is forwarded to litellm → OpenAI client
    extra_body={
        "chat_template_kwargs": {
            "thinking": True,
            "reasoning_effort": "high",
        }
    },
))
```

### 13.7 Offline safety

NVIDIA NIM calls are always blocked when `BENNY_OFFLINE=1` is set, because
`is_local_model("nvidia/...")` returns `False`. The offline kill-switch applies
regardless of which NVIDIA model is requested.

```powershell
$env:BENNY_OFFLINE = "1"
benny run manifests/my_manifest.json   # nvidia/* tasks raise OfflineRefusal
$env:BENNY_OFFLINE = ""
```

### 13.8 Verify the setup

```powershell
# Check the key is readable by benny
python -c "import os; k=os.environ.get('NVIDIA_API_KEY',''); print('Key set:', bool(k), '| Length:', len(k))"

# Quick live call (costs a fraction of a cent)
python -c "
import asyncio, os
from benny.core.models import call_model
r = asyncio.run(call_model(
    model='nvidia/meta/llama-3.3-70b-instruct',
    messages=[{'role':'user','content':'Reply with exactly: NVIDIA_OK'}],
    max_tokens=10,
))
print(r)
"

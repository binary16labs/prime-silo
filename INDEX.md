# Prime-Silo Documentation Index

> Complete navigation for all Prime-Silo documentation

## Quick Links by Role

| Role                    | Start Here                               | Then Read                              | For Reference                                      |
| ----------------------- | ---------------------------------------- | -------------------------------------- | -------------------------------------------------- |
| **Desktop App User**    | [QUICKSTART-EXE.md](QUICKSTART-EXE.md)   | [GUIDE.md](GUIDE.md)                   | [HOME-DIRECTORY.md](HOME-DIRECTORY.md)             |
| **CLI / Developer**     | [CLI.md](CLI.md)                         | [QUICKSTART-EXE.md](QUICKSTART-EXE.md) | [AGENTS.md](AGENTS.md)                             |
| **AI Agent**            | [AGENT-AWARENESS.md](AGENT-AWARENESS.md) | [CLI.md](CLI.md)                       | [HOME-DIRECTORY.md](HOME-DIRECTORY.md)             |
| **Project Contributor** | [AGENTS.md](AGENTS.md)                   | [runtime/README.md](runtime/README.md) | [architecture/ROADMAP.md](architecture/ROADMAP.md) |

---

## Root-Level Documentation

### Getting Started

- **[README.md](README.md)** — Project overview, mission statement, quick start, and repo layout
- **[QUICKSTART-EXE.md](QUICKSTART-EXE.md)** — Download, install, and configure the desktop application (for end users)
- **[QUICKSTART.md](QUICKSTART.md)** — Developer quick start (if exists)

### User Guides

- **[GUIDE.md](GUIDE.md)** — Plain-English walkthroughs for every UI screen, feature, and workflow
- **[CLI.md](CLI.md)** — Complete reference for command-line commands (`node space` and `benny` commands)
- **[HOME-DIRECTORY.md](HOME-DIRECTORY.md)** — Workspace directory structure, file locations, and configuration
- **[AGENT-AWARENESS.md](AGENT-AWARENESS.md)** — System state queries and permissions for AI agents

### Architecture & Contracts

- **[AGENTS.md](AGENTS.md)** — Architecture rules, documentation policy, and project contracts
  - Explains the documentation hierarchy
  - Lists all AGENTS.md files in the project
  - Defines stable contracts for contributors

### Release & Deployment

- **[RELEASE-QUICK-START.md](RELEASE-QUICK-START.md)** — Quick reference for cutting releases
- **[RELEASE.md](RELEASE.md)** — Complete release procedures and workflows
- **[SETUP-SUMMARY.md](SETUP-SUMMARY.md)** — Configuration overview for deployment

---

## Feature Documentation

### Home Directory & Configuration

- **[HOME-DIRECTORY.md](HOME-DIRECTORY.md)** — Complete workspace structure guide
  - Where files are stored
  - Configuring home directory in desktop app
  - File locations on different platforms (Windows, macOS, Linux)
  - For agents and scripts (IPC handler reference)

### Memory & Sessions

- **Command:** `node space memory <command>`
- **See:** [CLI.md](CLI.md#memory--memory-graph-operations)
- **UI Page:** `#/_prime_silo/memory` (if Memo-Ray connected)
- **For agents:** [AGENT-AWARENESS.md](AGENT-AWARENESS.md) (Memory Graph Status)

### Bridge Cockpit

- **Command:** `node space bridge <command>`
- **See:** [CLI.md](CLI.md#bridge--bridge-cockpit-operations)
- **UI Page:** `#/_prime_silo/bridge`
- **Modes:** Pulse, Memory, Documents, Code, Flows, Runs
- **For agents:** [AGENT-AWARENESS.md](AGENT-AWARENESS.md) (Bridge Status)

### Manifests & Workflows

- **Run a manifest:** See [GUIDE.md](GUIDE.md) §5c or [CLI.md](CLI.md#Part-2-Benny-Python-Commands)
- **Create a manifest:** [CLI.md](CLI.md#plan--ai-generate-manifest)
- **Deterministic zone:** [README.md](README.md) (ADR-001) or [runtime/architecture/](runtime/architecture/)

### Knowledge & Code Graphs

- **Knowledge graph:** Ingested documents, RAG, semantic triples
- **Code graph:** Tree-Sitter analysis, AST visualization
- **Correlation:** Knowledge + Code enrichment pipeline
- **See:** [GUIDE.md](GUIDE.md) §5 or [runtime/docs/](runtime/docs/)

---

## CLI Commands Reference

### Node.js Commands (`node space`)

| Command       | Purpose                   | See                                                         |
| ------------- | ------------------------- | ----------------------------------------------------------- |
| `serve`       | Start the server          | [CLI.md#serve](CLI.md#serve--start-the-server)              |
| `supervise`   | Run with auto-updates     | [CLI.md#supervise](CLI.md#supervise--run-with-auto-updates) |
| `help`        | Show command help         | [CLI.md#help](CLI.md#help--show-command-help)               |
| `version`     | Show version              | [CLI.md#version](CLI.md#version--show-version)              |
| `get` / `set` | Manage configuration      | [CLI.md#get--set](CLI.md#get--set--manage-configuration)    |
| `user`        | Manage users              | [CLI.md#user](CLI.md#user--manage-users)                    |
| `group`       | Manage groups             | [CLI.md#group](CLI.md#group--manage-groups)                 |
| `update`      | Update from Git           | [CLI.md#update](CLI.md#update--update-from-git)             |
| `memory`      | Memory graph operations   | [CLI.md#memory](CLI.md#memory--memory-graph-operations)     |
| `bridge`      | Bridge cockpit operations | [CLI.md#bridge](CLI.md#bridge--bridge-cockpit-operations)   |
| `registry`    | Query module registry     | [CLI.md#registry](CLI.md#registry--query-module-registry)   |

### Benny Python Commands (`benny`)

#### Manifest Operations

| Command   | Purpose              | See                                              |
| --------- | -------------------- | ------------------------------------------------ |
| `plan`    | AI-generate manifest | [CLI.md#plan](CLI.md#plan--ai-generate-manifest) |
| `run`     | Execute manifest     | [CLI.md#run](CLI.md#run--execute-manifest)       |
| `runs ls` | List run history     | [CLI.md#runs](CLI.md#runs--manage-run-history)   |

#### Pypes Transformations

| Command              | Purpose                | See                                                                 |
| -------------------- | ---------------------- | ------------------------------------------------------------------- |
| `pypes run`          | Execute transformation | [CLI.md#pypes-run](CLI.md#pypes-run--transformation-pipeline)       |
| `pypes inspect`      | Validate manifest      | [CLI.md#pypes-inspect](CLI.md#pypes-inspect--validate-manifest)     |
| `pypes drilldown`    | Analyze results        | [CLI.md#pypes-drilldown](CLI.md#pypes-drilldown--analyze-results)   |
| `pypes rerun`        | Resume from step       | [CLI.md#pypes-rerun](CLI.md#pypes-rerun--resume-from-step)          |
| `pypes plan`         | AI-generate pipeline   | [CLI.md#pypes-plan](CLI.md#pypes-plan--ai-generate-pipeline)        |
| `pypes agent-report` | AI analysis            | [CLI.md#pypes-agent-report](CLI.md#pypes-agent-report--ai-analysis) |

#### Other Commands

| Command       | Purpose              | See                                                   |
| ------------- | -------------------- | ----------------------------------------------------- |
| `enrich`      | Knowledge enrichment | [CLI.md#enrich](CLI.md#enrich--knowledge-enrichment)  |
| `agentamp`    | Skin pack operations | [CLI.md#agentamp](CLI.md#agentamp-commands)           |
| `up` / `down` | Service lifecycle    | [CLI.md#up--down](CLI.md#up--down--service-lifecycle) |

---

## Directory-Specific Documentation

### `app/` — Frontend

- **[app/AGENTS.md](app/AGENTS.md)** — Frontend architecture and contracts
- **Module docs:** Each major module has its own `AGENTS.md` (see main [AGENTS.md](AGENTS.md) for index)

### `server/` — Node.js Server

- **[server/AGENTS.md](server/AGENTS.md)** — Server architecture and contracts
- **Key areas:**
  - Proxy to Benny runtime
  - API routes
  - Configuration management

### `commands/` — CLI Commands

- **[commands/AGENTS.md](commands/AGENTS.md)** — CLI command contracts
- **[commands/params.yaml](commands/params.yaml)** — Configuration parameter schema
- Individual command files:
  - `serve.js`, `supervise.js`, `user.js`, `group.js`, etc.

### `packaging/` — Desktop Application

- **[packaging/AGENTS.md](packaging/AGENTS.md)** — Desktop build and packaging contracts
- **Key files:**
  - `packaging/desktop/main.js` — Electron main process
  - `packaging/desktop/tray.js` — System tray implementation
  - `.github/workflows/release-desktop.yml` — Build pipeline

### `runtime/` — Vendored Benny

- **[runtime/README.md](runtime/README.md)** — Benny overview
- **[runtime/CLAUDE.md](runtime/CLAUDE.md)** — Agent navigation guide for Benny
- **Documentation:**
  - `runtime/docs/operations/` — Operation guides
  - `runtime/docs/operations/PYPES_TRANSFORMATION_GUIDE.md` — Pypes reference
  - `runtime/architecture/` — Design decisions and ADRs
- **Tests:** `runtime/tests/` (~200 pytest tests)

### `scripts/` — Development Scripts

- **[scripts/README.md](scripts/README.md)** — Script command reference
- **Key scripts:**
  - `dev.ps1` / `dev.sh` — Local development with auto-restart
  - `manage-release.js` / `manage-release.ps1` — Release automation

### `site/` — Interactive Demo

- **[site/](site/)** — Self-contained feature tour
- **Launch:** `python -m http.server 4173 --directory site`
- **Includes:**
  - Configuration wizard
  - Live operator dashboard
  - Feature walkthrough

### `architecture/` — Project Architecture

- **[architecture/ROADMAP.md](architecture/ROADMAP.md)** — Phase-by-phase status
- **[architecture/OPERATING_MANUAL.md](architecture/OPERATING_MANUAL.md)** — Complete setup and operations guide
- **[architecture/OPERATING_PLAN.md](architecture/OPERATING_PLAN.md)** — Test runbook and dev loop

---

## Topic-Based Guide

### Setting Up Prime-Silo

1. **Desktop App?** → [QUICKSTART-EXE.md](QUICKSTART-EXE.md)
2. **Development?** → [architecture/OPERATING_MANUAL.md](architecture/OPERATING_MANUAL.md)
3. **Production?** → [SETUP-SUMMARY.md](SETUP-SUMMARY.md)
4. **Custom workspace?** → [HOME-DIRECTORY.md](HOME-DIRECTORY.md)

### Running Workflows

1. **Via UI?** → [GUIDE.md](GUIDE.md)
2. **Via CLI?** → [CLI.md](CLI.md)
3. **Benny Pypes?** → [CLI.md#Part-2-Benny-Python-Commands](CLI.md#part-2-benny-python-commands) + [runtime/docs/operations/PYPES_TRANSFORMATION_GUIDE.md](runtime/docs/operations/PYPES_TRANSFORMATION_GUIDE.md)

### Configuring Models

1. **Cloud model (OpenRouter)?** → [GUIDE.md](GUIDE.md) §4a
2. **Local model (Ollama)?** → [GUIDE.md](GUIDE.md) §4b
3. **Advanced?** → [HOME-DIRECTORY.md](HOME-DIRECTORY.md)

### Integration & Automation

1. **Memo-Ray memory graph?** → [CLI.md#memory](CLI.md#memory--memory-graph-operations)
2. **Bridge cockpit?** → [CLI.md#bridge](CLI.md#bridge--bridge-cockpit-operations)
3. **Custom modules?** → [AGENTS.md](AGENTS.md) + [app/AGENTS.md](app/AGENTS.md)

### Troubleshooting

1. **Desktop app?** → [QUICKSTART-EXE.md](QUICKSTART-EXE.md) §Troubleshooting
2. **CLI commands?** → [CLI.md](CLI.md) §Troubleshooting
3. **Benny runtime?** → [runtime/docs/operations/](runtime/docs/operations/)

### Releasing & Deployment

1. **Quick release?** → [RELEASE-QUICK-START.md](RELEASE-QUICK-START.md)
2. **Full procedure?** → [RELEASE.md](RELEASE.md)
3. **Multi-platform build?** → [.github/workflows/release-desktop.yml](.github/workflows/release-desktop.yml)

---

## For Different Audiences

### End Users (Desktop App)

Start here:

1. [QUICKSTART-EXE.md](QUICKSTART-EXE.md) — Install and launch
2. [HOME-DIRECTORY.md](HOME-DIRECTORY.md) — Understand workspace
3. [GUIDE.md](GUIDE.md) — Feature walkthroughs

Then:

- Reference [CLI.md](CLI.md) if using command line
- Check [HOME-DIRECTORY.md](HOME-DIRECTORY.md) for troubleshooting

### Operators

Start here:

1. [architecture/OPERATING_MANUAL.md](architecture/OPERATING_MANUAL.md) — Complete setup guide
2. [SETUP-SUMMARY.md](SETUP-SUMMARY.md) — Configuration overview
3. [CLI.md](CLI.md) — All available commands

Then:

- [RELEASE.md](RELEASE.md) for deployment
- [runtime/docs/operations/](runtime/docs/operations/) for advanced topics

### Developers

Start here:

1. [AGENTS.md](AGENTS.md) — Project contracts and architecture rules
2. [README.md](README.md) — Quickstart and repo layout
3. [runtime/architecture/ADR-001-prime-silo-shell-fork.md](runtime/architecture/ADR-001-prime-silo-shell-fork.md) — Design decisions

Then:

- [app/AGENTS.md](app/AGENTS.md), [server/AGENTS.md](server/AGENTS.md), [commands/AGENTS.md](commands/AGENTS.md)
- [architecture/ROADMAP.md](architecture/ROADMAP.md) for current phase status
- [architecture/OPERATING_PLAN.md](architecture/OPERATING_PLAN.md) for test runbook

### AI Agents

Start here:

1. [AGENT-AWARENESS.md](AGENT-AWARENESS.md) — System state and permissions
2. [CLI.md](CLI.md) — Available commands
3. [HOME-DIRECTORY.md](HOME-DIRECTORY.md) — File structure

Then:

- [runtime/CLAUDE.md](runtime/CLAUDE.md) for Benny-specific capabilities
- [app/L0/\_all/mod/\_core/documentation/docs/](app/L0/_all/mod/_core/documentation/docs/) for detailed API docs

---

## File Organization Summary

```
prime-silo/
├── README.md                    # Project overview & role-based entry points
├── INDEX.md                     # This file — complete navigation
├── QUICKSTART-EXE.md           # Desktop app quick start
├── CLI.md                       # All commands reference
├── GUIDE.md                     # Feature walkthroughs
├── HOME-DIRECTORY.md            # Workspace structure
├── AGENT-AWARENESS.md           # For AI agents
├── AGENTS.md                    # Architecture contracts
├── RELEASE-QUICK-START.md       # Quick release reference
├── RELEASE.md                   # Release procedures
├── SETUP-SUMMARY.md             # Configuration overview
│
├── app/                         # Frontend (React)
│   └── AGENTS.md               # Frontend contracts
├── server/                      # Node.js server
│   └── AGENTS.md               # Server contracts
├── commands/                    # CLI commands
│   ├── AGENTS.md               # Command contracts
│   └── params.yaml             # Configuration schema
├── packaging/                   # Desktop application
│   └── AGENTS.md               # Desktop contracts
├── runtime/                     # Vendored Benny
│   ├── CLAUDE.md               # Benny agent guide
│   ├── docs/operations/        # Operation guides
│   └── architecture/           # Design decisions
├── scripts/                     # Development scripts
│   └── README.md               # Script reference
├── architecture/               # Project architecture
│   ├── ROADMAP.md              # Phase status
│   ├── OPERATING_MANUAL.md     # Setup & operations
│   └── OPERATING_PLAN.md       # Test runbook
└── site/                       # Interactive demo
```

---

## Documentation Standards

All documentation in Prime-Silo follows these standards (see [AGENTS.md](AGENTS.md)):

- **Hierarchical** — Root docs are abstract; leaf docs are concrete
- **Contracts first** — Architecture and stable contracts before implementation
- **Plain English** — User guides use simple language
- **Complete examples** — Every command includes usage examples
- **Links everywhere** — Cross-reference related docs
- **Keep it tidy** — Remove stale or duplicate documentation immediately

---

## How to Update This Index

When adding new documentation:

1. Create the `.md` file in the appropriate location
2. Add a reference to this INDEX.md
3. Link the new doc from relevant parent docs
4. Update the role-based quick links at the top if it's a major guide

When removing documentation:

1. Update all cross-references
2. Remove the entry from this INDEX.md
3. Remove the entry from parent docs

---

## Questions?

- **User question?** Check [GUIDE.md](GUIDE.md)
- **Command question?** Check [CLI.md](CLI.md)
- **Architecture question?** Check [AGENTS.md](AGENTS.md)
- **Agent question?** Check [AGENT-AWARENESS.md](AGENT-AWARENESS.md)
- **Report a bug?** [GitHub Issues](https://github.com/binary16labs/prime-silo/issues)

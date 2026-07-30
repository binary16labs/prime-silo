# Prime-Silo // Sovereign AI Agent OS & Harness

<div align="center">

[![Live Web Substrate](https://img.shields.io/badge/🌐_Live_Demo-binary16labs.github.io%2Fprime--silo-00A67E?style=for-the-badge)](https://binary16labs.github.io/prime-silo/)
[![GitHub Stars](https://img.shields.io/github/stars/binary16labs/prime-silo?style=for-the-badge&color=D97706)](https://github.com/binary16labs/prime-silo/stargazers)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg?style=for-the-badge)](https://opensource.org/licenses/MIT)
[![Sovereign AI](https://img.shields.io/badge/Sovereign_AI-Zero_Token_Tax-8B5CF6?style=for-the-badge)](https://binary16labs.github.io/prime-silo/)
[![Protocol: MCP & A2A](https://img.shields.io/badge/Protocol-MCP_%7C_A2A_Native-06B6D4?style=for-the-badge)](https://binary16labs.github.io/prime-silo/)

**The canonical Sovereign AI Agent OS and runtime harness — engineered for institutional cognition by Binary 16 Labs & Agent Benny.**

[Explore Live Web Substrate](https://binary16labs.github.io/prime-silo/) • [Read Architecture Spine](#determinism-boundary-adr-001) • [View Token Economics](https://binary16labs.github.io/prime-silo/#calculator)

</div>

---

> _"Stop gambling with probabilistic cloud wrappers. Start executing with deterministic institutional reasoning."_

**Prime-Silo** is an open-source typed execution substrate and **Agent OS harness** designed for organizations requiring data sovereignty, zero token tax, and verifiable lineage. It fuses two breakthrough architectures:

- **[Benny](https://github.com/skybluecycology/benny)** — the deterministic substrate (**Pypes Layer 0** transformation algebra, swarm-executed cognitive operations, triple-lineage governance, manifest signing). Vendored here under `runtime/`.
- **[Space-Agent](https://github.com/agent0ai/space-agent)** — the adaptive shell (browser-resident agent runtime, modular puzzle-piece UI, Git-backed workspace versioning).

### 🏛️ Why Prime-Silo is Trending in 2026

While traditional agent frameworks suffer from context bloat, cloud gatekeeper fees, and brittle custom code, Prime-Silo delivers:

1. **Model Context Protocol (MCP) Native**: Universal tool connectivity ("USB-C for AI") without code fragmentation or custom wrappers.
2. **Agent-to-Agent (A2A) Swarm Collaboration**: Built-in open communication standards for specialized agent swarms to discover and execute tasks autonomously.
3. **Zero Token Tax Execution**: Deterministic Pypes transformation algebra runs locally, eliminating recursive cloud context dumps and saving up to 90% in token overhead.
4. **HMAC SHA-256 Auditable Lineage**: Every state transition, UI layout, and decision trace is cryptographically signed and auditable.

---

The goal: a single **Agent OS** shell that gives institutional operators one nav, one theme, one run timeline, and one audit story across documents, code, tabular data, and post-run review — without ever compromising determinism or burning capital on cloud context bloat.

## Determinism boundary (ADR-001)

Prime-Silo splits surfaces into two zones, with different agent authority in each:

| Zone               | Surfaces                                                                                            | Agent authority                                                             | Where it lives           |
| ------------------ | --------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | ------------------------ |
| **Deterministic**  | Manifest authoring, run execution, KG/code graph mutation, L3 writes, skill registry                | Read-only. Drafts → HITL → `sign_manifest()` → run                          | Static React widgets     |
| **Review (fluid)** | Post-run drill-down, frame inspection, reasoning trace, audit query, agent-composed analyst reports | Read everything; write only to `agent_sandbox/{views,notes,drafts,skills}/` | Adaptive composed canvas |

Pinned agent-composed layouts become `.aamp.view` bundles, HMAC-signed via the existing skin-pack signing path. Replaying a layout is deterministic and auditable.

See [`runtime/architecture/ADR-001-prime-silo-shell-fork.md`](runtime/architecture/ADR-001-prime-silo-shell-fork.md) for the full decision record, [`architecture/ROADMAP.md`](architecture/ROADMAP.md) for the rolling phase status, and [`architecture/OPERATING_PLAN.md`](architecture/OPERATING_PLAN.md) for the test runbook + dev loop.

## Documentation by Role

**👤 Desktop App Users** — Start here:

- **[QUICKSTART-EXE.md](QUICKSTART-EXE.md)** — Download, install, and launch the desktop app
- [HOME-DIRECTORY.md](HOME-DIRECTORY.md) — Configure where your data is stored
- [GUIDE.md](GUIDE.md) — Feature walkthroughs and UI help

**💻 Command-Line Users** — Start here:

- **[CLI.md](CLI.md)** — Complete reference for `node space` and `benny` commands
- [QUICKSTART-EXE.md](QUICKSTART-EXE.md) — Desktop setup (if needed)
- [GUIDE.md](GUIDE.md) — Step-by-step usage examples

**🤖 AI Agents** — Start here:

- **[AGENT-AWARENESS.md](AGENT-AWARENESS.md)** — System state, API endpoints, sandbox permissions
- [CLI.md](CLI.md) — Available CLI tools for agents
- [HOME-DIRECTORY.md](HOME-DIRECTORY.md) — Workspace file structure

**🔧 Developers** — Start here:

- [AGENTS.md](AGENTS.md) — Architecture rules and contracts
- [`runtime/architecture/ADR-001-prime-silo-shell-fork.md`](runtime/architecture/ADR-001-prime-silo-shell-fork.md) — Design decisions
- [`architecture/OPERATING_MANUAL.md`](architecture/OPERATING_MANUAL.md) — Deep-dive dev setup

**📚 Full Documentation Index:**

- See [INDEX.md](INDEX.md) for the complete navigation map

---

**Interactive demo site:** [`site/`](site/) — self-contained website that tours every feature (with layer-by-layer deconstruction views), embeds the operating manual, and ships a **configuration wizard** (generates your `.env` + `prime-silo.config.json` + launch commands, each setting mapped to the process that consumes it) plus a **live operator dashboard** that health-checks your running stack. No build step:

```powershell
.\scripts\site.ps1            # or: python -m http.server 4173 --directory site
# → open http://localhost:4173
```

**Companion — [Memo-Ray](https://github.com/binary16labs/memo-ray):** the _memory graph_ of the cognitive mesh — the third first-class graph beside the knowledge graph (documents) and code graph (AST). It X-rays Claude + Antigravity session logs into an explorable organic lineage map so the operator never has to be the institutional memory. Clone it beside this repo (or set `MEMORAY_DIR`); `.\scripts\dev.ps1` auto-boots it when enabled.

As of **Phase M1** the memory graph is **built into the shell** — one capability on four surfaces, all over a single configurable proxy (`/api/memoray`, endpoint via `MEMORAY_BASE_URL` or the wizard manifest):

- **Page** — `#/_prime_silo/memory`: Command Center cards, session list, lineage graph, node inspector, a conformance strip, and first-class offline/disabled screens.
- **Agent skill** — `memory-recall`: the onscreen agent answers "what was I working on / which sessions touched file X" by querying the graph itself.
- **CLI** — `node space memory <status|sync|sessions|search|audit>`.
- **Self-audit** — the integration is declared in [`manifests/integrations/memoray.integration.json`](manifests/integrations/memoray.integration.json) (data model + process map + config surface, HMAC-signed). `GET /api/integration_audit` / `node space memory audit` / `node scripts/audit-integrations.mjs` probe live reality against that declaration and emit a drift report whose findings carry the owner path to fix — so an agent (or a local LLM via Lemonade) can maintain it without spelunking. See [`manifests/integrations/AGENTS.md`](manifests/integrations/AGENTS.md).

### Bridge — one cockpit for the whole mesh

**Phase B** ropes the scattered pages into a single calm surface at **`#/_prime_silo/bridge`** — designed for one mental model, not six tabs. A mode rail (Pulse · Memory · Documents · Code 3D · Flows · Runs), one stage, and **Benny** (the onscreen agent) in the dock, grounded in whatever's on screen so you can ask "explain this" / "what did I work on" and get a real answer with a deep link back.

- **Golden paths, not copy-paste** — _Flows_: type a requirement → **Plan** renders the DAG → **Run** flips to live observability. _Documents_: pick a workspace → manage files → **Ingest** turns documents into semantic triples (rendered as the knowledge graph) → **Correlate** links them to the code graph.
- **3D when you want it** — Code 3D and the knowledge graph default to an offline-safe 2D layout with a one-click 3D (WebGL) toggle.
- **Same thesis** — declared as a signed manifest ([`manifests/integrations/bridge.integration.json`](manifests/integrations/bridge.integration.json)) covered by the self-audit, and ubiquitous: page + `benny-pilot` agent skill + `node space bridge <status|plan|run|ingest|open>`. Configurable landing via `BRIDGE_DEFAULT_MODE`. Pulse carries Memo-Ray's `/api/lifelog` activity feed (sessions + artifacts + git commits).

## Repo layout

```
prime-silo/
├── app/                      # space-agent — browser frontend
├── server/                   # space-agent — thin Node.js shell server
├── space/                    # space-agent — agent runtime
├── packaging/                # space-agent — desktop builds
├── runtime/                  # vendored from skybluecycology/benny
│   ├── benny/                #   FastAPI backend, Pypes, swarm, governance
│   ├── manifests/            #   Pypes/swarm manifests
│   ├── tests/                #   pytest suite (~200 tests)
│   ├── docs/                 #   operator manuals, ADRs, requirements
│   └── architecture/         #   ADR-001 lives here
├── scripts/                  # prime-silo dev/launch scripts
└── README.md                 # this file
```

## Status

- [x] **Phase A** — agent sandbox boundary, scope guard middleware, widget registry contract, agent-authorship lineage emitter (in `runtime/benny/`)
- [x] **Phase B** — fork bootstrap; Benny vendored under `runtime/`, space-agent shell merged
- [x] **Phase C** — eight canvases migrated to the shell widget tree (text.markdown, run.reasoning_trace, run.lineage_timeline, run.drilldown_table, run.frame_inspector, kg3d.synoptic_web, codegraph.canvas, dag.canvas)
- [x] **Phase D / D2 / D3** — runtime transport, agent-context chokepoint, agent saved-views helpers
- [x] **Phase F / F2 / F2b** — `.aamp.view` HMAC sign / verify / pin / load chokepoint; pinned views are self-describing signed JSON, `GET /api/views/load/<ws>/<filename>` returns `{view, signature, valid}` in one round-trip
- [x] **Phase E** — first deterministic-zone shell page (`manifest_explorer`) lists registered swarm manifests and renders the selected one as `dag.canvas`. No agent context — `runtimeFetch` with no scope.
- [x] **Phase H1** — session checkpoints: save/restore/fork session state (history + skills + staged data + run refs); draft endpoints under the agent sandbox, human-only HMAC pinning
- [x] **Phase M1** — memory graph in-shell: Memo-Ray integration declared as a signed `aamp.integration/1` manifest (data model + process map + config surface), surfaced on four surfaces (page `#/_prime_silo/memory`, `memory-recall` agent skill, `node space memory` CLI, `/api/integration_audit` self-audit) over one configurable proxy
- [x] **Phase B (Bridge)** — one cockpit (`#/_prime_silo/bridge`) unifying memory, documents→triples, code, flows and runs with Benny grounded in the stage; signed `bridge.integration.json`; ubiquitous (page + `benny-pilot` skill + `node space bridge`); carries Memo-Ray's lifelog feed
- [ ] **Phase M2** — LLM self-maintenance loop: a swarm manifest that runs the audit → `call_model()` (Lemonade local) → drafts fixes into `agent_sandbox/drafts/` for human pinning
- [ ] **Phase G** — canvas consolidation; retire ManifestCanvas/PipelineCanvas/WorkflowCanvas duplication in the runtime frontend

Phase status is tracked rolling in [`architecture/ROADMAP.md`](architecture/ROADMAP.md). The original phase rationale lives in [`runtime/architecture/ADR-001-prime-silo-shell-fork.md`](runtime/architecture/ADR-001-prime-silo-shell-fork.md) §8.

## Quickstart

```powershell
# 1. Install Python + Node deps
cd runtime
python -m pip install -e .
cd ..\server
npm install
cd ..

# 2. Set required environment (HMAC key — runtime owns it; browser never sees it)
$env:BENNY_HMAC_KEY = "<64-hex-character key>"   # see OPERATING_MANUAL.md §2.5 for how to generate

# 3. Boot runtime + shell in parallel
.\scripts\dev.ps1                                # bash users: ./scripts/dev.sh

# 4. Verify the ADR-001 surfaces are live
curl http://localhost:8005/api/agent_sandbox/health
curl http://localhost:8005/api/widgets

# 5. Browse manifests in the shell:
#    open http://localhost:3000/#/_prime_silo/manifest_explorer
```

A full setup-from-scratch walkthrough, including prerequisites, HMAC key generation, smoke tests, and a feature-by-feature usage guide, lives in [`architecture/OPERATING_MANUAL.md`](architecture/OPERATING_MANUAL.md).

## Updating the vendored Benny tree

```bash
git remote add benny https://github.com/skybluecycology/benny.git   # one-time
git subtree pull --prefix=runtime benny master --squash
```

Fixes that originate in `runtime/` go back upstream as PRs against `skybluecycology/benny`. Anything touching `runtime/benny/` lands upstream first; the fork only owns:

- Space-agent shell customisations
- Migrated React widget components (Phase C onward)
- `.aamp.view` view bundles
- Fork-specific docs

## License

Space-agent shell code under [`LICENSE`](LICENSE) (inherited from upstream). The vendored Benny tree retains its own license at [`runtime/LICENSE`](runtime/LICENSE) where applicable.

---

_Prime-Silo — engineered by Binary 16._

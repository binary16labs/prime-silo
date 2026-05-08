# Prime-Silo

> The first, foundational, canonical silo of institutional cognition — engineered by Binary 16.

Prime-Silo is an open-source typed execution substrate for institutional reasoning, fused with an adaptive browser-resident shell. It is the convergence of two projects:

- **[Benny](https://github.com/skybluecycology/benny)** — the deterministic substrate (Pypes Layer 0 transformation algebra, swarm-executed Layer 1 cognitive operations, triple-lineage governance, manifest signing). Vendored here under `runtime/`.
- **[Space-Agent](https://github.com/agent0ai/space-agent)** — the adaptive shell (browser-resident agent runtime, puzzle-piece module modularity, Git-backed workspace versioning). Forked as the outer application.

The goal: a single shell that gives operators one nav, one theme, one run timeline, and one audit story across documents, code, tabular data, and post-run review — without compromising the determinism, signing, and lineage guarantees that make the substrate auditable.

## Determinism boundary (ADR-001)

Prime-Silo splits surfaces into two zones, with different agent authority in each:

| Zone               | Surfaces                                                                                                  | Agent authority                                                              | Where it lives           |
| ------------------ | --------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ------------------------ |
| **Deterministic**  | Manifest authoring, run execution, KG/code graph mutation, L3 writes, skill registry                      | Read-only. Drafts → HITL → `sign_manifest()` → run                           | Static React widgets     |
| **Review (fluid)** | Post-run drill-down, frame inspection, reasoning trace, audit query, agent-composed analyst reports       | Read everything; write only to `agent_sandbox/{views,notes,drafts,skills}/` | Adaptive composed canvas |

Pinned agent-composed layouts become `.aamp.view` bundles, HMAC-signed via the existing skin-pack signing path. Replaying a layout is deterministic and auditable.

See [`runtime/architecture/ADR-001-prime-silo-shell-fork.md`](runtime/architecture/ADR-001-prime-silo-shell-fork.md) for the full decision record, [`architecture/ROADMAP.md`](architecture/ROADMAP.md) for the rolling phase status, and [`architecture/OPERATING_PLAN.md`](architecture/OPERATING_PLAN.md) for the test runbook + dev loop.

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
- [x] **Phase F / F2** — `.aamp.view` HMAC sign / verify / pin chokepoint; pinned views are self-describing signed JSON
- [ ] **Phase E** — deterministic-zone surfaces rendered as static (non-agent-mutable) shell pages
- [ ] **Phase G** — canvas consolidation; retire ManifestCanvas/PipelineCanvas/WorkflowCanvas duplication in the runtime frontend

Phase status is tracked rolling in [`architecture/ROADMAP.md`](architecture/ROADMAP.md). The original phase rationale lives in [`runtime/architecture/ADR-001-prime-silo-shell-fork.md`](runtime/architecture/ADR-001-prime-silo-shell-fork.md) §8.

## Quickstart (Phase B — backend boot only)

Frontend integration ships in Phase D. Today you can boot the deterministic substrate and exercise the agent-sandbox API.

```powershell
# 1. Install Python deps
cd runtime
python -m pip install -e .

# 2. Set required environment
$env:BENNY_HOME = "$PWD\.benny_home"
$env:BENNY_HMAC_KEY = "<hex key — same one your skin packs use>"

# 3. Boot the FastAPI runtime
python -m benny.api.server
# → http://localhost:8005

# 4. Verify the ADR-001 surfaces are live
curl http://localhost:8005/api/agent_sandbox/health
curl http://localhost:8005/api/widgets

# 5. Sandbox writes succeed; non-sandbox writes return 403
curl -X POST http://localhost:8005/api/agent_sandbox/write `
  -H "X-Benny-Agent-Scope: sandbox" -H "Content-Type: application/json" `
  -d '{\"workspace\":\"default\",\"subdir\":\"notes\",\"filename\":\"hello.md\",\"content\":\"# hi\"}'
```

A turnkey dev script (Node shell + Python runtime) lives in [`scripts/dev.ps1`](scripts/dev.ps1) and [`scripts/dev.sh`](scripts/dev.sh).

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

*Prime-Silo — engineered by Binary 16.*

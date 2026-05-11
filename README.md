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

**New here? Start with [`GUIDE.md`](GUIDE.md)** — plain-English walkthroughs for every UI screen and CLI command, including local model (Lemonade/Ollama) setup and the quick-reference cheat sheet.

**Operator's entry point:** [`architecture/OPERATING_MANUAL.md`](architecture/OPERATING_MANUAL.md) — deep-dive setup from scratch, boot procedure, walkthroughs for every shipped feature (manifest browsing, agent draft views, pinning + load-time integrity replay, the eight migrated widgets, the 3D renderer), and a diagnostic playbook.

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

*Prime-Silo — engineered by Binary 16.*

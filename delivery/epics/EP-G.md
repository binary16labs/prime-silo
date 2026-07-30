# EP-G — DAG-native workflow core

**Objective:** O2 · **Goals:** P3,P4 · **Milestone:** M1
**Plan source:** `../../architecture/PLAN-local-power-unified-ui.md` (workstream G)

One run-event stream per DAG execution = progress+telemetry+lineage; BennyTUI DAG tracker; verbs registry generating CLI/REST/agent tools (parity by construction) + MCP-registry publishing; workflow-type catalog + guided wizard.

## Phases → task contracts

- [ ] `G0` — unified run-event stream (lineage = fold; OpenLineage = optional tail adapter; node_heartbeat liveness events)
- [ ] `G1` — DAG-aware TUI tracker (evolve BennyTUI)
- [ ] `G2` — verbs registry + live run view + MCP registry publishing
- [ ] `G3` — workflow-type catalog + wizard + agent-assisted authoring (step ceiling ≤12)

## Exit

All phase gates green, verified by non-author agent; close with a VISION-CHECK note (plan §0.5):
which KRs moved, measured evidence, one honest sentence on drift.

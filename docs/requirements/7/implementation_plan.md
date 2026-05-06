# Benny Studio: Evolution Blueprint (V1 → V2)

This plan implements the high-fidelity **"God-Mode" UI (v2)** as a parallel, togglable experience. This ensures stability while allowing for an incremental rollout of advanced 3D and holographic features.

## V1/V2 Strategy: The "Mesh Toggle"

We will introduce a `uiVersion` state in the global store.
- **V1 (Default)**: The current standard dashboard interface.
- **V2 (God-Mode)**: The immersive, 3D spatial cockpit.
- **Toggle**: Accessible via the "COGNITIVE MESH" branding in the HUD or a system setting in the Nav Rail.

## Feature Coverage & Mapping Matrix

| Current (V1) Feature | God-Mode (V2) Equivalent | Status |
| :--- | :--- | :--- |
| **Workflow Canvas** | **3D Swarm Spatial Canvas** | Planned |
| **Node Palette** | **Holographic Asset/Agent Hub** | Planned |
| **Config Panel** | **Exploded Node / Omni-Dialog** | Planned |
| **Execution Bar** | **Mission Control HUD (Top Bar)** | Planned |
| **Audit Hub (Terminal)** | **Synaptic Stream + Governance Log** | Planned |
| **Knowledge Graph** | **Synoptic Web (3D Knowledge)** | Planned |
| **Swarm Config/State** | **Telemetry HUD + Temporal Scrubber** | Planned |
| **Global Admin** | **Governance & Safety Cockpit** | Planned |
| **Notebook View** | **Holographic Data Shards** | Planned |

---

## Proposed Changes

### [Core: Versioned State]

#### [MODIFY] [App.tsx](file:///c:/Users/nsdha/OneDrive/code/benny/frontend/src/App.tsx)
- Implement `uiVersion` state logic.
- Conditionally render `<AppV1 />` or `<AppV2 />` (using the `GodModeHUD` as the root wrapper for V2).

### [Backend: Observation Stream]

#### [MODIFY] [swarm.py](file:///c:/Users/nsdha/OneDrive/code/benny/benny/graph/swarm.py)
- Update all nodes to emit `v2_telemetry` events containing the "Exploded Detail" data (sub-processes, HEX heartbeats, and specific file lineages).

### [Frontend: Phase 1 (Core V2 Shell)]

#### [NEW] [AppV2.tsx](file:///c:/Users/nsdha/OneDrive/code/benny/frontend/src/AppV2.tsx)
- The root cockpit component that replaces the standard sidebar/canvas layout with the immersive HUD.

#### [MODIFY] [index.css](file:///c:/Users/nsdha/OneDrive/code/benny/frontend/src/index.css)
- Implement double-themed CSS tokens. V2 will exclusively use the `Obsidian/Cyan/Orange` palette.

### [Frontend: Phase 2 (Interactive Canvas)]

#### [NEW] [SwarmCanvas3D.tsx](file:///c:/Users/nsdha/OneDrive/code/benny/frontend/src/components/Studio/SwarmCanvas3D.tsx)
- 3D orchestration view with orbiting agents and energy trails.
- Implementation of the "Explosion" effect when clicking nodes.

## Open Questions

> [!WARNING]
> **State Sync**: We must ensure that a workflow started in V1 still renders its progress correctly if the user toggles to V2 mid-execution.

## Verification Plan

### Automated Tests
- `npm test`: Verify that switching `uiVersion` doesn't crash the React context.
- `python -m pytest`: Verify that `swarm.py` emits the new telemetry events without affecting graph execution.

### Manual Verification
- Toggle V2 switch in the HUD and verify the transition to the 3D Obsidian theme.
- Trigger a swarm run in V1, switch to V2, and verify the 3D clusters animate the correct nodes.

### Automated Tests
- Run a dummy swarm with 2-3 nodes.
- Verify that `workspace/test4/runs/{execution_id}/RUN_MANIFEST.md` exists and contains the expected ASCII DAG and node results.
- Verify `task_registry.json` contains the `topology` object.

### Manual Verification
- Execute "The Architect's Pivot" workflow.
- Open the run directory as the process runs and tail the `RUN_MANIFEST.md` to see live updates.

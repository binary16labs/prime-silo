# Task: Benny Studio Evolution (V1 → V2)

## Phase 1: Infrastructure & The Cockpit Shell [/]
- `[ ]` Install 3D dependencies (`@react-three/fiber`, `@react-three/drei`).
- `[ ]` Update `zustand` store with `uiVersion` state and `uiToggle` action.
- `[ ]` Implement `AppV2` root wrapper and conditional rendering in `App.tsx`.
- `[ ]` Setup V2 "Obsidian" CSS theme and glassmorphism utilities.
- `[ ]` Build `GodModeHUD` (Top Rail, Global Status, Halt Switch).

## Phase 2: Backend & Sync [/]
- `[ ]` Implement `v2_telemetry` emission in `swarm.py` nodes.
- `[ ]` Register full graph topology in `task_manager` during swarm compilation.
- `[ ]` Ensure real-time state sync between V1/V2 (Event Bus mapping).

## Phase 3: Spatial Canvas & Knowledge Mesh [/]
- `[ ]` Implement `SwarmCanvas3D` with energy clusters and agent orbits.
- `[ ]` Build the "Explosion" effect for node-level details.
- `[ ]` Port the Knowledge Graph to 3D `SynopticWeb`.

## Phase 4: Omni-Dialog & Feature Parity [/]
- `[ ]` Build the multipurpose `OmniDialog` for detailed inspections.
- `[ ]` Migrate `Marketplace` to V2 (Card Grid).
- `[ ]` Implement the Temporal Time-Travel Scrubber.

## Phase 5: Polish & UX [/]
- `[ ]` Stress test 3D performance on large swarms.
- `[ ]` Final visual polish (neon glows, pulse animations).

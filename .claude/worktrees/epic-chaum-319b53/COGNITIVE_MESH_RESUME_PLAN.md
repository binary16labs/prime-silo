# Cognitive Mesh — Resume Plan

**Branch:** `claude/vibrant-raman-b93bfb`
**Feature:** 3D Spatial IDE upgrade for the Graph tab (Benny Studio v2)
**Source of truth:** Research paper "Architecting the Cognitive Mesh" (in conversation history).
**Checkpoint commit:** this commit.
**Handoff rule:** read this file top-to-bottom, follow sections in order, do not skip integration order. Every task has acceptance criteria and paste-ready code. Do not invent new patterns — copy the skeletons.

---

## 0. Quick facts / orientation

- Worktree root: `C:/Users/nsdha/OneDrive/code/benny/.claude/worktrees/vibrant-raman-b93bfb`
- Frontend app: `frontend/` — React 19 + Vite 7 + TypeScript 5.9, Zustand, three.js 0.183, @react-three/fiber 9, @react-three/drei 10, framer-motion.
- Graph tab component: `frontend/src/components/Studio/CodeGraphCanvas.tsx` — the 3D scene. Rendered from `AppV2Beta.tsx` when `viewMode === 'graph'`.
- Control panel: `frontend/src/components/Studio/GraphNexusController.tsx` — docked overlay with tiers/filters/performance.
- State: Zustand in `frontend/src/hooks/useWorkflowStore.ts`, composed from slices in `frontend/src/hooks/slices/` (uiSlice, executionSlice, workflowSlice).
- Graph data shape (from backend `/api/graph/code/lod`):
  ```ts
  { nodes: [{ id, name, type, position: [x,y,z], metadata? }], edges: [{ source, target, type, metadata? }] }
  ```
- No test framework is wired up — verification is **BDD manual scenarios** plus `npm run build` typecheck.

Commands you will use:

```bash
# From the worktree root:
cd frontend
npm install            # only if node_modules missing
npm run build          # type-check + bundle — MUST succeed with 0 errors before claiming done
npm run dev            # local dev server for manual BDD testing
npm run lint           # optional but nice
```

---

## 1. Status at checkpoint

### 1.1 Completed files (do NOT rewrite — extend only if needed)

| File | Purpose | Status |
|---|---|---|
| `frontend/src/hooks/slices/uiSlice.ts` | Zustand slice. Added `cognitiveMesh` object + `toggleCognitiveMesh` + `setCognitiveMeshValue`. | Done |
| `frontend/src/components/Studio/graph/CognitiveMeshEngine.ts` | Pure graph analysis: `analyzeMesh`, `computeBlastRadius`, `getEdgeImportance`, `edgeKey`. | Done |
| `frontend/src/components/Studio/graph/SonificationEngine.ts` | Singleton `Sonification` — WebAudio cues for hover/click/cycle/error/prune/commit + ambient heartbeat. | Done |
| `frontend/src/components/Studio/graph/useSemanticZoom.ts` | Hook returning `{ tier, distance }` where `tier ∈ 'macro'|'meso'|'micro'`. Thresholds: `>=90` macro, `40–90` meso, `<40` micro. | Done |
| `frontend/src/components/Studio/graph/DataFlowParticles.tsx` | InstancedMesh of particles sliding along edges. Props: `edges, livePositions, density, pulseEdgeKeys`. | Done |

### 1.2 Remaining tasks (MUST do in this order, but 2.1–2.6 are independent components — OK to batch)

1. `NeuralNebula.tsx` — particle clouds around community centroids.
2. `CycleOverlay.tsx` — highlight detected cycles as glowing loops.
3. `BlastRadiusHighlight.tsx` — hook + render helper for selection illumination.
4. `AgentOrbit.tsx` — orbiting sprites around selected node.
5. `AgenticPanel.tsx` — JSON-declarative contextual panel renderer.
6. `TimeTravelScrubber.tsx` — compressed-history playback control.
7. **Integration:** modify `CodeGraphCanvas.tsx` to use all of the above, thread `cognitiveMesh` state through, enhance node/edge rendering (myelination, degree sizing, semantic zoom, foveated LOD, synaptic pruning).
8. **Controls:** add `CognitiveMeshControls` section to `GraphNexusController.tsx`.
9. `npm run build` — fix any TS errors until 0 errors.
10. BDD manual test pass (see §5).
11. Commit + summary for user.

---

## 2. Component specs (one per section). For each: Goal → Files → BDD → Code skeleton → Verify → Pitfalls.

Every component lives in `frontend/src/components/Studio/graph/`. They are **independent** — you can build them in parallel. They only come together in `CodeGraphCanvas.tsx` (task 7).

### 2.1 NeuralNebula.tsx

**Goal:** render a translucent point-cloud around each cluster centroid so communities look like nebulae. Only visible when `showClusters` AND `cognitiveMesh.neuralNebula`.

**Files:** create `frontend/src/components/Studio/graph/NeuralNebula.tsx` only.

**BDD:**
- *Given* the graph has nodes with `metadata.community_id` set **and** `cognitiveMesh.neuralNebula = true` **and** `showClusters = true`,
  *when* the canvas renders,
  *then* I see soft colored point-clouds surrounding each community centroid; color matches the community's HSL hue `(community_id * 137.5) % 360`.
- *Given* `cognitiveMesh.neuralNebula = false`,
  *when* the canvas renders,
  *then* no nebula particles are drawn.

**Paste-ready skeleton:**

```tsx
import React, { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';

interface NebulaProps {
  centroids: Map<number, [number, number, number]>;
  density: number;          // 0..3
  enabled: boolean;
  rotate: boolean;          // cluster rotation toggle
}

// One nebula per community — generate points in a gaussian blob.
export function NeuralNebula({ centroids, density, enabled, rotate }: NebulaProps) {
  const groupRef = useRef<THREE.Group>(null);

  const blobs = useMemo(() => {
    if (!enabled) return [];
    const out: Array<{ id: number; positions: Float32Array; color: THREE.Color; center: [number, number, number] }> = [];
    centroids.forEach((center, id) => {
      const count = Math.round(120 * density);
      const positions = new Float32Array(count * 3);
      const radius = 6;
      for (let i = 0; i < count; i++) {
        // Gaussian-ish: sum of uniforms → bell
        const r = radius * Math.pow(Math.random(), 0.5);
        const theta = Math.random() * Math.PI * 2;
        const phi = Math.acos(2 * Math.random() - 1);
        positions[i * 3]     = center[0] + r * Math.sin(phi) * Math.cos(theta);
        positions[i * 3 + 1] = center[1] + r * Math.sin(phi) * Math.sin(theta);
        positions[i * 3 + 2] = center[2] + r * Math.cos(phi);
      }
      const color = new THREE.Color(`hsl(${(id * 137.5) % 360}, 70%, 60%)`);
      out.push({ id, positions, color, center });
    });
    return out;
  }, [centroids, density, enabled]);

  useFrame((_, delta) => {
    if (!rotate || !groupRef.current) return;
    groupRef.current.rotation.y += delta * 0.04;
  });

  if (!enabled || blobs.length === 0) return null;

  return (
    <group ref={groupRef}>
      {blobs.map(blob => (
        <points key={blob.id}>
          <bufferGeometry>
            <bufferAttribute
              attach="attributes-position"
              args={[blob.positions, 3]}
              count={blob.positions.length / 3}
            />
          </bufferGeometry>
          <pointsMaterial
            size={0.25}
            color={blob.color}
            transparent
            opacity={0.35}
            sizeAttenuation
            depthWrite={false}
            blending={THREE.AdditiveBlending}
          />
        </points>
      ))}
    </group>
  );
}
```

**Verify:** renders without warnings when toggled on; disappears when toggled off. No console errors. `npm run build` clean.

**Pitfalls:**
- Must pass `args={[positions, 3]}` to `bufferAttribute`, **not** `array={positions} itemSize={3}`, because react-three-fiber 9 enforces the args tuple.
- Don't forget `depthWrite={false}` or nebula occludes other things.

---

### 2.2 CycleOverlay.tsx

**Goal:** render each detected cycle as a closed LineLoop in pulsing color. Reads cycles from `analysis.cycles: string[][]`.

**Files:** create `frontend/src/components/Studio/graph/CycleOverlay.tsx` only.

**BDD:**
- *Given* `cognitiveMesh.cycleDetection = true` and `analysis.cycles` has at least one cycle,
  *when* the canvas renders,
  *then* each cycle appears as a magenta-ish closed loop connecting the nodes in the cycle, pulsing in opacity.
- *Given* `cognitiveMesh.cycleDetection = false`,
  *when* the canvas renders,
  *then* no cycle overlays are drawn.

**Paste-ready skeleton:**

```tsx
import React, { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { Line } from '@react-three/drei';
import * as THREE from 'three';

interface Props {
  cycles: string[][];
  livePositions: React.MutableRefObject<Map<string, THREE.Vector3>>;
  enabled: boolean;
}

export function CycleOverlay({ cycles, livePositions, enabled }: Props) {
  const lineRefs = useRef<Array<any>>([]);
  const pointsCache = useMemo(
    () => cycles.map(() => [new THREE.Vector3(), new THREE.Vector3()]),
    [cycles]
  );

  useFrame(({ clock }) => {
    if (!enabled) return;
    const pulse = 0.5 + 0.5 * Math.sin(clock.elapsedTime * 1.8);
    cycles.forEach((cycle, i) => {
      const lineRef = lineRefs.current[i];
      if (!lineRef || !lineRef.geometry) return;
      const positions: number[] = [];
      for (let j = 0; j < cycle.length; j++) {
        const p = livePositions.current.get(cycle[j]);
        if (p) positions.push(p.x, p.y, p.z);
      }
      if (positions.length >= 6) {
        // close the loop
        positions.push(positions[0], positions[1], positions[2]);
        lineRef.geometry.setPositions(positions);
        lineRef.computeLineDistances?.();
      }
      const mat = lineRef.material;
      if (mat) mat.opacity = 0.25 + 0.5 * pulse;
    });
  });

  if (!enabled || cycles.length === 0) return null;

  return (
    <group>
      {cycles.map((cycle, i) => (
        <Line
          key={i}
          ref={(r: any) => { lineRefs.current[i] = r; }}
          points={pointsCache[i]}
          color="#FF00FF"
          lineWidth={2.5}
          transparent
          opacity={0.6}
          dashed={false}
        />
      ))}
    </group>
  );
}
```

**Verify:** toggling `cycleDetection` on shows magenta loops around detected cycles; off hides them. Cycles come from `analyzeMesh(...).cycles`.

**Pitfalls:**
- drei's `<Line>` ref exposes `.geometry.setPositions(flatArray)`. Pass a flat number[] of length `3 * pointCount`.
- If cycles list changes, pointsCache will re-memo, triggering line re-mount — that's fine.

---

### 2.3 BlastRadiusHighlight.tsx

**Goal:** export `useBlastRadius(analysis, selectedId, enabled)` returning `{ downstreamNodes, upstreamNodes, downstreamEdgeKeys, upstreamEdgeKeys }`. Used by CodeGraphCanvas to dim/brighten nodes & edges.

**Files:** create `frontend/src/components/Studio/graph/BlastRadiusHighlight.tsx`.

**BDD:**
- *Given* `cognitiveMesh.blastRadius = true` and a node is selected,
  *when* I click a node,
  *then* all downstream-reachable nodes light up bright neon and all unrelated nodes dim to ~25% opacity; upstream ancestors glow a distinct color.
- *Given* no node is selected,
  *when* the canvas renders,
  *then* no dimming is applied.

**Paste-ready skeleton:**

```tsx
import { useMemo } from 'react';
import type { MeshAnalysis, MeshEdge } from './CognitiveMeshEngine';
import { computeBlastRadius, edgeKey } from './CognitiveMeshEngine';

export interface BlastResult {
  downstreamNodes: Set<string>;
  upstreamNodes: Set<string>;
  downstreamEdgeKeys: Set<string>;
  upstreamEdgeKeys: Set<string>;
  hasSelection: boolean;
}

const EMPTY: BlastResult = {
  downstreamNodes: new Set(),
  upstreamNodes: new Set(),
  downstreamEdgeKeys: new Set(),
  upstreamEdgeKeys: new Set(),
  hasSelection: false,
};

export function useBlastRadius(
  analysis: MeshAnalysis | null,
  edges: MeshEdge[],
  selectedId: string | null,
  enabled: boolean
): BlastResult {
  return useMemo(() => {
    if (!enabled || !analysis || !selectedId) return EMPTY;
    const r = computeBlastRadius(analysis, edges, selectedId, 6);
    return {
      downstreamNodes: r.downstream,
      upstreamNodes: r.upstream,
      downstreamEdgeKeys: r.downstreamEdges,
      upstreamEdgeKeys: r.upstreamEdges,
      hasSelection: true,
    };
  }, [analysis, edges, selectedId, enabled]);
}

// Helper used at render time:
export function blastOpacity(
  isSelected: boolean,
  inDownstream: boolean,
  inUpstream: boolean,
  hasSelection: boolean,
  defaultOpacity: number
): number {
  if (!hasSelection) return defaultOpacity;
  if (isSelected) return 1;
  if (inDownstream || inUpstream) return Math.min(1, defaultOpacity + 0.25);
  return defaultOpacity * 0.25;
}

export function blastColorTint(
  inDownstream: boolean,
  inUpstream: boolean,
  base: string
): string {
  if (inDownstream) return '#39FF14'; // neon green for downstream
  if (inUpstream) return '#FF5F1F';   // orange for upstream
  return base;
}

export { edgeKey };
```

**Verify:** click a node with `blastRadius` on → only connected subgraph is bright; others dim. Contract test by adding a throwaway `console.log(blast)` in CodeGraphCanvas while developing.

**Pitfalls:**
- `computeBlastRadius` is O(N*E) in the worst case. That's OK for tier-3 graphs but keep `maxDepth=6`.

---

### 2.4 AgentOrbit.tsx

**Goal:** when `cognitiveMesh.agentOrbit = true` and a node is selected, render small sprite-discs orbiting the selected node at radius 2.5. Each sprite represents an "agent" identity (can be stubbed with 3 fixed agents for now).

**Files:** create `frontend/src/components/Studio/graph/AgentOrbit.tsx`.

**BDD:**
- *Given* a node is selected and `agentOrbit = true`,
  *when* time passes,
  *then* 3 colored agent sprites orbit the node at different angular speeds.
- *Given* `agentOrbit = false`,
  *when* time passes,
  *then* no agent sprites are visible.

**Paste-ready skeleton:**

```tsx
import React, { useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { Html } from '@react-three/drei';
import * as THREE from 'three';

interface Props {
  selectedPos: THREE.Vector3 | null;
  enabled: boolean;
}

const AGENTS = [
  { id: 'planner',  label: 'PLAN',  color: '#00FFFF', speed: 0.6 },
  { id: 'critic',   label: 'CRIT',  color: '#FF00FF', speed: 0.9 },
  { id: 'builder',  label: 'BUILD', color: '#39FF14', speed: 1.2 },
];

export function AgentOrbit({ selectedPos, enabled }: Props) {
  const groupRef = useRef<THREE.Group>(null);

  useFrame(({ clock }) => {
    if (!enabled || !selectedPos || !groupRef.current) return;
    groupRef.current.position.copy(selectedPos);
    groupRef.current.rotation.y = clock.elapsedTime * 0.4;
  });

  if (!enabled || !selectedPos) return null;

  return (
    <group ref={groupRef}>
      {AGENTS.map((a, i) => {
        const angle = (i / AGENTS.length) * Math.PI * 2;
        const r = 2.8;
        return (
          <group key={a.id} position={[Math.cos(angle) * r, 0, Math.sin(angle) * r]}>
            <mesh>
              <sphereGeometry args={[0.18, 12, 12]} />
              <meshBasicMaterial color={a.color} transparent opacity={0.9} />
            </mesh>
            <Html center distanceFactor={14}>
              <div className="pointer-events-none select-none">
                <div
                  className="px-1.5 py-0.5 rounded bg-black/70 border border-white/20 text-[7px] font-black font-mono tracking-widest uppercase"
                  style={{ color: a.color }}
                >
                  {a.label}
                </div>
              </div>
            </Html>
          </group>
        );
      })}
    </group>
  );
}
```

**Verify:** select any node → see PLAN/CRIT/BUILD orbiting; deselect → gone.

**Pitfalls:**
- `selectedPos` must be the node's live position vector. In CodeGraphCanvas, look up `livePositions.current.get(selectedNodeId)`.

---

### 2.5 AgenticPanel.tsx

**Goal:** render a small HUD panel built from a JSON widget schema — this is the declarative A2UI framework from the paper. Stub the agent (no LLM call) — hardcode a demo schema based on the selected node.

**Files:** create `frontend/src/components/Studio/graph/AgenticPanel.tsx`.

**BDD:**
- *Given* `cognitiveMesh.agenticPanels = true` and a node is selected,
  *when* the canvas renders,
  *then* a small docked panel appears (top-right area, below existing Graph_Commands) showing the node name, type, degree count, and three action chips (`Trace`, `Prune`, `Summon`) — click handlers can be no-ops/console.log for now.
- *Given* no node selected OR `agenticPanels = false`,
  *when* the canvas renders,
  *then* no panel is rendered.

**Panel schema contract** (future-proof for real agents):

```ts
export interface AgenticWidget {
  kind: 'panel';
  title: string;
  fields: Array<{ label: string; value: string }>;
  actions: Array<{ id: string; label: string; color?: string }>;
}
```

**Paste-ready skeleton:**

```tsx
import React from 'react';
import { motion } from 'framer-motion';
import type { MeshAnalysis } from './CognitiveMeshEngine';

export interface AgenticWidget {
  kind: 'panel';
  title: string;
  fields: Array<{ label: string; value: string }>;
  actions: Array<{ id: string; label: string; color?: string }>;
}

interface Props {
  selectedNode: any | null;
  analysis: MeshAnalysis | null;
  enabled: boolean;
  onAction: (actionId: string) => void;
}

export function buildWidgetForNode(node: any, analysis: MeshAnalysis | null): AgenticWidget {
  const degree = analysis?.degreeMap.get(node.id) ?? 0;
  return {
    kind: 'panel',
    title: node.name || node.id,
    fields: [
      { label: 'Type', value: String(node.type) },
      { label: 'Degree', value: String(degree) },
      { label: 'Community', value: String(node.metadata?.community_name || node.metadata?.community_id || '—') },
    ],
    actions: [
      { id: 'trace',  label: 'Trace',  color: '#00FFFF' },
      { id: 'prune',  label: 'Prune',  color: '#FF5F1F' },
      { id: 'summon', label: 'Summon', color: '#FF00FF' },
    ],
  };
}

export function AgenticPanel({ selectedNode, analysis, enabled, onAction }: Props) {
  if (!enabled || !selectedNode) return null;
  const widget = buildWidgetForNode(selectedNode, analysis);

  return (
    <motion.div
      initial={{ opacity: 0, x: 20 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: 20 }}
      className="absolute top-[380px] right-4 z-40 w-64 rounded-2xl border border-[#00FFFF]/20 bg-black/60 backdrop-blur-xl p-4 shadow-[0_0_24px_rgba(0,255,255,0.08)]"
    >
      <div className="text-[8px] font-black text-[#00FFFF]/50 uppercase tracking-[0.2em] mb-2">A2UI_CONTEXT</div>
      <div className="text-[11px] font-black text-white tracking-wider truncate" title={widget.title}>{widget.title}</div>
      <div className="mt-3 space-y-1.5">
        {widget.fields.map(f => (
          <div key={f.label} className="flex items-center justify-between text-[9px] font-mono">
            <span className="text-white/40">{f.label}</span>
            <span className="text-white/90 truncate max-w-[140px]" title={f.value}>{f.value}</span>
          </div>
        ))}
      </div>
      <div className="mt-3 flex flex-wrap gap-1.5">
        {widget.actions.map(a => (
          <button
            key={a.id}
            onClick={(e) => { e.stopPropagation(); onAction(a.id); }}
            className="px-2.5 py-1 rounded-lg border text-[8px] font-black tracking-widest uppercase hover:bg-white/10 transition-all"
            style={{ color: a.color || '#FFFFFF', borderColor: (a.color || '#FFFFFF') + '40' }}
          >
            {a.label}
          </button>
        ))}
      </div>
    </motion.div>
  );
}
```

**Verify:** select a node → panel appears upper-right with real degree count; buttons are clickable and log to console.

**Pitfalls:**
- Panel is a DOM overlay, NOT inside Canvas. Place it as a sibling to `<Canvas>` in CodeGraphCanvas's return tree.

---

### 2.6 TimeTravelScrubber.tsx

**Goal:** a thin bottom-docked strip with a range slider over the catalog's snapshot list. Scrubbing updates `activeGraphId` to the chosen snapshot and emits a sonification "commit" event. Only visible when `cognitiveMesh.timeTravelOpen = true`.

**Files:** create `frontend/src/components/Studio/graph/TimeTravelScrubber.tsx`.

**BDD:**
- *Given* `cognitiveMesh.timeTravelOpen = true` and `graphCatalog` has ≥ 2 code snapshots,
  *when* I drag the scrub slider,
  *then* the scrub index updates AND `activeGraphId` is set to the snapshot at that index AND sonification emits a `commit` event per step (throttled).
- *Given* `cognitiveMesh.timeTravelOpen = false`,
  *when* the canvas renders,
  *then* the scrubber is not visible.

**Paste-ready skeleton:**

```tsx
import React, { useMemo, useRef } from 'react';
import { useWorkflowStore } from '../../../hooks/useWorkflowStore';
import { useWorkspaceStore } from '../../../hooks/useWorkspaceStore';
import { Sonification } from './SonificationEngine';
import { Clock, ChevronsRight } from 'lucide-react';

export function TimeTravelScrubber() {
  const { cognitiveMesh, setCognitiveMeshValue } = useWorkflowStore();
  const { graphCatalog, activeGraphId, setActiveGraphId } = useWorkspaceStore();
  const lastEmit = useRef(0);

  const snapshots = useMemo(
    () => graphCatalog.filter(g => g.type === 'code').sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0)),
    [graphCatalog]
  );

  if (!cognitiveMesh.timeTravelOpen) return null;
  if (snapshots.length < 2) {
    return (
      <div className="absolute bottom-6 left-1/2 -translate-x-1/2 z-30 px-4 py-2 rounded-full bg-black/60 border border-white/10 text-[9px] font-mono text-white/40 tracking-widest uppercase">
        Need ≥ 2 snapshots to scrub
      </div>
    );
  }

  const idx = Math.min(cognitiveMesh.timeScrubIndex, snapshots.length - 1);
  const current = snapshots[idx];

  const onChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = Number(e.target.value);
    setCognitiveMeshValue('timeScrubIndex', v);
    const snap = snapshots[v];
    if (snap && snap.id !== activeGraphId) {
      setActiveGraphId(snap.id);
      const now = performance.now();
      if (now - lastEmit.current > 120) {
        Sonification.emit('commit', { pitchOffset: (v % 12) - 6 });
        lastEmit.current = now;
      }
    }
  };

  return (
    <div className="absolute bottom-24 left-1/2 -translate-x-1/2 z-30 w-[640px] max-w-[80vw] rounded-2xl bg-black/70 border border-[#FF5F1F]/30 backdrop-blur-xl px-5 py-4 shadow-2xl">
      <div className="flex items-center justify-between mb-2 text-[8px] font-black tracking-[0.25em] uppercase">
        <div className="flex items-center gap-2 text-[#FF5F1F]/70">
          <Clock size={10} /> TIME_TRAVEL
        </div>
        <div className="flex items-center gap-2 text-white/50 font-mono">
          <span>{current?.name || '—'}</span>
          <ChevronsRight size={10} />
          <span>{idx + 1}/{snapshots.length}</span>
        </div>
      </div>
      <input
        type="range"
        min={0}
        max={snapshots.length - 1}
        step={1}
        value={idx}
        onChange={onChange}
        className="w-full h-1.5 bg-white/10 rounded-full appearance-none cursor-pointer accent-[#FF5F1F]"
      />
      <div className="mt-2 flex items-center justify-between text-[7px] font-mono text-white/30">
        <span>{new Date(snapshots[0].timestamp || Date.now()).toLocaleDateString()}</span>
        <span>COMPRESSION {cognitiveMesh.timeCompression}x</span>
        <span>{new Date(snapshots[snapshots.length - 1].timestamp || Date.now()).toLocaleDateString()}</span>
      </div>
    </div>
  );
}
```

**Verify:** open time travel → drag slider → graph switches to older snapshot; each step produces an audible click (if sonification on).

**Pitfalls:**
- `useWorkspaceStore` exposes `graphCatalog` and `setActiveGraphId` — confirm by reading `frontend/src/hooks/useWorkspaceStore.ts` if signatures drift. If `setActiveGraphId` doesn't exist, fall back to the existing mechanism (refresh `activeGraphId` via whatever setter is wired in `GraphNexusController`).

---

## 3. Integration: CodeGraphCanvas.tsx (the hard part)

**Goal:** wire the engine + all 6 components into the main canvas, and enhance existing node/edge rendering (myelination, degree sizing, foveated LOD, synaptic pruning, semantic zoom).

**File:** `frontend/src/components/Studio/CodeGraphCanvas.tsx` (edit only, don't rewrite).

### 3.1 Imports to add near the top

```tsx
import { analyzeMesh, edgeKey as meshEdgeKey } from './graph/CognitiveMeshEngine';
import type { MeshAnalysis } from './graph/CognitiveMeshEngine';
import { Sonification } from './graph/SonificationEngine';
import { useSemanticZoom } from './graph/useSemanticZoom';
import { DataFlowParticles } from './graph/DataFlowParticles';
import { NeuralNebula } from './graph/NeuralNebula';
import { CycleOverlay } from './graph/CycleOverlay';
import { AgentOrbit } from './graph/AgentOrbit';
import { AgenticPanel } from './graph/AgenticPanel';
import { TimeTravelScrubber } from './graph/TimeTravelScrubber';
import { useBlastRadius, blastOpacity, blastColorTint } from './graph/BlastRadiusHighlight';
```

### 3.2 Pull state from the store

Extend the existing `useWorkflowStore(...)` destructure:

```tsx
const {
  // ...existing fields...
  cognitiveMesh,
  setCognitiveMeshValue,
} = useWorkflowStore();
const executionEvents = useWorkflowStore(s => s.executionEvents);
```

### 3.3 Compute analysis once per graph change

Right after `processedGraph` useMemo, add:

```tsx
const analysis = useMemo<MeshAnalysis | null>(() => {
  if (!processedGraph.nodes.length) return null;
  return analyzeMesh(processedGraph.nodes, processedGraph.edges);
}, [processedGraph]);
```

### 3.4 Compute blast radius from selection

```tsx
const blast = useBlastRadius(analysis, processedGraph.edges, selectedNodeId, cognitiveMesh.blastRadius);
```

### 3.5 Compute current edge pulse set from execution events

```tsx
const pulseEdgeKeys = useMemo<Set<string>>(() => {
  const keys = new Set<string>();
  if (!cognitiveMesh.dataFlowParticles) return keys;
  const recent = executionEvents.slice(-25);
  for (const evt of recent) {
    if (!evt.nodeId) continue;
    // pulse every edge touching this node
    for (const e of processedGraph.edges) {
      if (e.source === evt.nodeId || e.target === evt.nodeId) {
        keys.add(meshEdgeKey(e as any));
      }
    }
  }
  return keys;
}, [executionEvents, processedGraph.edges, cognitiveMesh.dataFlowParticles]);
```

### 3.6 Semantic zoom — inside CodeGraphScene

Add near the top of `CodeGraphScene`:

```tsx
const { tier: zoomTier } = useSemanticZoom(cognitiveMesh.semanticZoom);
```

Then pass `zoomTier` down to each `<CodeSymbolNode>` and `<CodeGraphEdge>` and to `<NeuralNebula>`, etc.

### 3.7 Enhance CodeSymbolNode

Add new props: `degree: number`, `maxDegree: number`, `cognitiveMesh: UISlice['cognitiveMesh']`, `zoomTier: ZoomTier`, `isInDownstream: boolean`, `isInUpstream: boolean`, `hasBlastSelection: boolean`.

Inside the component:

- **Degree sizing:** multiply base scale by `1 + 0.8 * (degree / maxDegree)` when `cognitiveMesh.degreeSizing`.
- **Foveated LOD:** compute `const dist = camera.position.distanceTo(group.position)` once per frame; when `dist > 70 && cognitiveMesh.foveatedLOD`, swap geometry to a 6-segment sphere regardless of type (remove the complex meshes).
- **Semantic zoom:** when `zoomTier === 'macro'`, hide the name `<Html>` label; in `'meso'` show label always; in `'micro'` show full `FloatingMetadataHUD` always.
- **Synaptic pruning:** when `cognitiveMesh.synapticPruning && degree / maxDegree < cognitiveMesh.pruneThreshold`, multiply opacity by 0.2 and disable interaction.
- **Blast radius:** compute node opacity using `blastOpacity(isSelected, isInDownstream, isInUpstream, hasBlastSelection, 0.9)` and emissive tint via `blastColorTint`.
- **Sonification:** on pointerOver, if `cognitiveMesh.sonification`, `Sonification.emit('hover', { nodeType: type })`; on click, `Sonification.emit('click', { nodeType: type })`.

Minimal diff sketch:

```tsx
// inside CodeSymbolNode
useFrame(({ camera }) => {
  // ...existing position sync...
  if (groupRef.current && cognitiveMesh.degreeSizing) {
    const boost = 1 + 0.8 * (degree / Math.max(1, maxDegree));
    groupRef.current.scale.lerp(new THREE.Vector3(boost, boost, boost), 0.08);
  }
});

const baseOpacity = 0.9;
const eff = blastOpacity(isSelected, isInDownstream, isInUpstream, hasBlastSelection, baseOpacity);
const isPruned = cognitiveMesh.synapticPruning && (degree / Math.max(1, maxDegree)) < cognitiveMesh.pruneThreshold;
const finalOpacity = isPruned ? eff * 0.2 : eff;
```

### 3.8 Enhance CodeGraphEdge

New props: `importance: number`, `cognitiveMesh: UISlice['cognitiveMesh']`, `inDownstream: boolean`, `inUpstream: boolean`, `hasBlastSelection: boolean`.

- **Myelination:** when `cognitiveMesh.myelination`, `lineWidth = baseLineWidth * (1 + 2 * importance)` and boost opacity by `+ 0.2 * importance`.
- **Synaptic pruning:** when `importance < pruneThreshold` AND `synapticPruning`, multiply opacity by 0.15.
- **Blast radius:** apply `blastOpacity(false, inDownstream, inUpstream, hasBlastSelection, edgeOpacity)`.

### 3.9 Mount all new components inside the scene

Inside `CodeGraphScene` return, AFTER existing nodes/edges map:

```tsx
{cognitiveMesh.neuralNebula && analysis && showClusters && (
  <NeuralNebula
    centroids={analysis.communityCentroids}
    density={cognitiveMesh.particleDensity}
    enabled={cognitiveMesh.neuralNebula}
    rotate={cognitiveMesh.clusterRotation}
  />
)}
{cognitiveMesh.cycleDetection && analysis && (
  <CycleOverlay
    cycles={analysis.cycles}
    livePositions={livePositions}
    enabled={cognitiveMesh.cycleDetection}
  />
)}
{cognitiveMesh.dataFlowParticles && analysis && (
  <DataFlowParticles
    edges={processedGraph.edges.map((e: any) => ({
      source: e.source, target: e.target, type: e.type,
      importance: analysis.edgeImportance.get(meshEdgeKey(e)) ?? 0,
    }))}
    livePositions={livePositions}
    density={cognitiveMesh.particleDensity}
    pulseEdgeKeys={pulseEdgeKeys}
  />
)}
{cognitiveMesh.agentOrbit && selectedNodeId && (
  <AgentOrbit
    selectedPos={livePositions.current.get(String(selectedNodeId)) || null}
    enabled
  />
)}
```

### 3.10 Mount DOM-layer components outside Canvas

After the existing `Graph_Commands` div, add:

```tsx
<AgenticPanel
  selectedNode={selectedNode}
  analysis={analysis}
  enabled={cognitiveMesh.agenticPanels}
  onAction={(id) => {
    if (id === 'trace') Sonification.emit('edge_pulse');
    if (id === 'prune') Sonification.emit('prune');
    if (id === 'summon' && selectedNode?.position) flyToNode(selectedNode.position);
  }}
/>
<TimeTravelScrubber />
```

### 3.11 Wire sonification lifecycle

Near the top of `CodeGraphCanvas`, add:

```tsx
useEffect(() => {
  Sonification.setEnabled(cognitiveMesh.sonification);
  Sonification.setAmbient(cognitiveMesh.sonification && cognitiveMesh.ambientHeartbeat);
}, [cognitiveMesh.sonification, cognitiveMesh.ambientHeartbeat]);
```

---

## 4. Integration: GraphNexusController.tsx — CognitiveMeshControls section

Add a new collapsible section AFTER `Relationship_Audit` (before `Temporal_Reconstruction`). Paste this block where noted:

```tsx
{/* Cognitive Mesh Section */}
<div className="space-y-3 pt-2 border-t border-white/5">
  <div className="text-[9px] font-black text-[#FF00FF]/50 uppercase tracking-[0.2em] flex items-center gap-2">
    <Activity size={10} />
    Cognitive_Mesh
  </div>

  <div className="grid grid-cols-2 gap-1.5">
    {([
      ['semanticZoom', 'Semantic Zoom'],
      ['degreeSizing', 'Degree Sizing'],
      ['myelination', 'Myelination'],
      ['synapticPruning', 'Pruning'],
      ['blastRadius', 'Blast Radius'],
      ['dataFlowParticles', 'Flow Particles'],
      ['cycleDetection', 'Cycle Detect'],
      ['neuralNebula', 'Nebula'],
      ['clusterRotation', 'Cluster Rotate'],
      ['agentOrbit', 'Agent Orbit'],
      ['agenticPanels', 'A2UI Panels'],
      ['foveatedLOD', 'Foveated LOD'],
      ['sonification', 'Sonification'],
      ['ambientHeartbeat', 'Heartbeat'],
      ['timeTravelOpen', 'Time Travel'],
    ] as const).map(([key, label]) => {
      const on = cognitiveMesh[key] as boolean;
      return (
        <button
          key={key}
          onClick={() => toggleCognitiveMesh(key as any)}
          className={`px-2 py-1.5 rounded-lg border text-[8px] font-bold tracking-tighter uppercase transition-all ${
            on
              ? 'bg-[#FF00FF]/20 border-[#FF00FF]/50 text-[#FF00FF]'
              : 'bg-black/20 border-white/5 text-white/30'
          }`}
        >
          {label}
        </button>
      );
    })}
  </div>

  {/* Prune threshold slider */}
  <div className="space-y-1.5">
    <div className="flex justify-between text-[8px] text-white/60 font-mono">
      <span>Prune Threshold</span>
      <span className="text-[#FF00FF]">{cognitiveMesh.pruneThreshold.toFixed(2)}</span>
    </div>
    <input
      type="range" min={0} max={1} step={0.05}
      value={cognitiveMesh.pruneThreshold}
      onChange={e => setCognitiveMeshValue('pruneThreshold', Number(e.target.value))}
      className="w-full h-1.5 bg-white/10 rounded-full accent-[#FF00FF]"
    />
  </div>

  {/* Particle density slider */}
  <div className="space-y-1.5">
    <div className="flex justify-between text-[8px] text-white/60 font-mono">
      <span>Particle Density</span>
      <span className="text-[#FF00FF]">{cognitiveMesh.particleDensity.toFixed(1)}</span>
    </div>
    <input
      type="range" min={0} max={3} step={0.1}
      value={cognitiveMesh.particleDensity}
      onChange={e => setCognitiveMeshValue('particleDensity', Number(e.target.value))}
      className="w-full h-1.5 bg-white/10 rounded-full accent-[#FF00FF]"
    />
  </div>
</div>
```

Add to the destructure at the top of `GraphNexusController`:

```tsx
const { cognitiveMesh, toggleCognitiveMesh, setCognitiveMeshValue } = useWorkflowStore();
```

---

## 5. BDD Acceptance Test Plan (manual, run after integration)

Run `cd frontend && npm run dev` and open the graph tab with a loaded code snapshot. Check each scenario. Pass if all green.

### 5.1 Baseline
- **Given** the graph loads, **when** no cognitive-mesh flags are toggled off from defaults, **then** the graph renders without console errors AND degree-sized glowing nodes are visible AND data-flow particles stream along edges.

### 5.2 Semantic Zoom
- **Given** `semanticZoom` on, **when** I dolly the camera from ~80 to ~30 units, **then** node labels become persistently visible around 40 units and metadata satellites around 20 units.

### 5.3 Myelination + Pruning
- **Given** `myelination` on, **when** two edges connect different-degree nodes, **then** the higher-importance edge is visibly thicker/brighter.
- **Given** `synapticPruning` on with `pruneThreshold = 0.4`, **when** rendering, **then** low-degree nodes and their edges fade to ~20% opacity.

### 5.4 Blast Radius
- **Given** `blastRadius` on, **when** I click a node with downstream dependencies, **then** downstream nodes tint green and unrelated nodes dim to ~25% opacity.

### 5.5 Cycles
- **Given** `cycleDetection` on and the graph contains at least one cycle, **then** magenta loops appear and pulse.

### 5.6 Nebula + Cluster Rotation
- **Given** `showClusters = on`, `neuralNebula = on`, `clusterRotation = on`, **then** community-colored point clouds rotate slowly.

### 5.7 Agent Orbit + A2UI Panel
- **Given** a node is selected, `agentOrbit` on and `agenticPanels` on, **then** 3 labeled sprites orbit the node AND the A2UI_CONTEXT panel shows the node name + degree + action chips.

### 5.8 Sonification
- **Given** `sonification` on, **when** I hover nodes of different types, **then** different pitches play.
- **Given** `sonification + ambientHeartbeat` on, **then** a continuous low sub-tone plays.

### 5.9 Time Travel
- **Given** `timeTravelOpen` on and ≥ 2 code snapshots exist, **when** I scrub the slider, **then** the graph swaps to the chosen snapshot and a "commit" click tone plays.

### 5.10 No regressions
- RE_CENTER, RE_SCAN, DEEP_LAYOUT still work.
- Tier 1/2/3 still switches resolution.
- Relationship audit still toggles edge visibility.
- Existing SymbolInspector still opens on selection.

---

## 6. Final verification & commit

```bash
cd frontend
npm run build            # MUST be 0 errors
# If errors: read the first error, fix, re-run. Do not ignore "as any" casts that should be real types.
```

Then:

```bash
git add -A
git status               # sanity-check what's staged
git commit -m "Complete Cognitive Mesh integration"
```

Report back to user: list which BDD scenarios pass, note any that fail or any todos deferred.

---

## 7. Known risks / pitfalls (skim before coding)

1. **InstancedMesh color attribute** — in `DataFlowParticles`, re-assigning `instanceColor.array` only works if the attribute already exists with matching length. Safer: on first pass, create `new THREE.InstancedBufferAttribute(colorArr, 3)` and assign `meshRef.current.instanceColor = attr`; subsequently update in place.
2. **drei `<Line>` ref API** — `lineRef.current.geometry.setPositions(flatArray)` expects a flat array, NOT nested `[[x,y,z], [x,y,z]]`. Always flatten.
3. **Zustand selector churn** — don't subscribe to `cognitiveMesh` as a single object in sub-components; it will re-render on any toggle. Use `s => s.cognitiveMesh.semanticZoom` for individual flags in hot-path hooks if performance suffers. (For first pass, single-object destructure is fine.)
4. **WebAudio must be user-initiated** — `Sonification.setEnabled(true)` should only call `setAmbient(true)` after the user clicked the toggle, which counts as a user gesture. The engine handles this; do not call from `useEffect` before first user interaction.
5. **Snapshot timestamps** — catalog items may have `timestamp` as ISO string OR number. If sort looks wrong, coerce with `new Date(x).getTime()`.
6. **Cycle detection cost** — bounded to 30 search roots × 6 depth × 40 cycles cap. Don't raise bounds without profiling.
7. **Foveated LOD swapping meshes** — hot-swapping geometries per frame causes GPU churn. The skeleton swaps at a threshold (`dist > 70`) and is hysteretic only by accident — add ±5 unit hysteresis if flicker appears.
8. **Type: `useWorkspaceStore`** — if `setActiveGraphId` name differs, grep for the exact setter and match it in `TimeTravelScrubber`.

---

## 8. Definition of Done (the list a reviewer will actually use)

- [ ] All 6 remaining component files created under `frontend/src/components/Studio/graph/`.
- [ ] `CodeGraphCanvas.tsx` imports and mounts every component per §3.
- [ ] `GraphNexusController.tsx` renders the new `Cognitive_Mesh` section with 15 toggles + 2 sliders.
- [ ] `npm run build` exits with 0 TypeScript errors.
- [ ] All 10 BDD scenarios in §5 pass on a populated graph.
- [ ] No new runtime console errors under normal interaction.
- [ ] Commit made on `claude/vibrant-raman-b93bfb`.

End of plan.

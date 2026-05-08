// ADR-001 Phase E — pure mapping from a SwarmManifest envelope (as returned
// by /api/manifests/<id>) to the {nodes, edges} shape that dag.canvas
// renders. Kept pure and dependency-free so unit tests can hit it without
// jsdom or a runtime.
//
// The runtime SwarmManifest schema lives at runtime/benny/core/manifest.py;
// the bits this module reads:
//   manifest.id
//   manifest.requirement
//   manifest.plan.tasks       — each: { id, label?, status?, name?, prompt? }
//   manifest.plan.edges       — each: { source, target, label?, animated? }
//   manifest.plan.waves       — list-of-list-of-task-ids, position is wave index
//   (optional) run.node_states — { task_id: status } overlay from a RunRecord
//
// Output shape mirrors widgets/dag/canvas/index.js:
//   { nodes: [{ id, label, status, wave }], edges: [{ source, target }] }

const FALLBACK_STATUS = "pending";

function deriveLabel(task) {
  if (typeof task.label === "string" && task.label) return task.label;
  if (typeof task.name === "string" && task.name) return task.name;
  return task.id;
}

function buildWaveIndex(waves) {
  // waves is List[List[str]] where outer index is the wave number. Invert it
  // to a Map<task_id, wave_index> for O(1) lookup. A task that appears in
  // multiple waves (shouldn't, but defensive) takes the LOWEST wave so the
  // dag.canvas longest-path layout still works as a floor.
  const out = new Map();
  if (!Array.isArray(waves)) return out;
  for (let i = 0; i < waves.length; i++) {
    const wave = waves[i];
    if (!Array.isArray(wave)) continue;
    for (const taskId of wave) {
      if (typeof taskId !== "string") continue;
      if (!out.has(taskId)) out.set(taskId, i);
    }
  }
  return out;
}

/**
 * Map a SwarmManifest envelope to the data shape dag.canvas accepts.
 *
 * @param {object} manifest — runtime envelope, the body of GET /api/manifests/<id>
 * @param {{ runOverlay?: { node_states?: Record<string, string> } }} [options]
 *        Pass a RunRecord to overlay execution status onto manifest tasks.
 * @returns {{ nodes: Array<{id: string, label: string, status: string, wave?: number}>,
 *             edges: Array<{source: string, target: string, label?: string}> }}
 */
export function mapManifestToDagData(manifest, options = {}) {
  if (!manifest || typeof manifest !== "object") {
    throw new Error("mapManifestToDagData: manifest must be an object.");
  }
  const plan = manifest.plan && typeof manifest.plan === "object" ? manifest.plan : {};
  const tasks = Array.isArray(plan.tasks) ? plan.tasks : [];
  const edgesRaw = Array.isArray(plan.edges) ? plan.edges : [];
  const waveIndex = buildWaveIndex(plan.waves);
  const runOverlay = options.runOverlay && typeof options.runOverlay === "object"
    ? options.runOverlay
    : null;
  const overlayStates = runOverlay && runOverlay.node_states && typeof runOverlay.node_states === "object"
    ? runOverlay.node_states
    : null;

  const nodes = tasks
    .filter((task) => task && typeof task.id === "string" && task.id)
    .map((task) => {
      const node = {
        id: task.id,
        label: deriveLabel(task),
        status:
          (overlayStates && typeof overlayStates[task.id] === "string" && overlayStates[task.id]) ||
          (typeof task.status === "string" && task.status) ||
          FALLBACK_STATUS
      };
      if (waveIndex.has(task.id)) {
        node.wave = waveIndex.get(task.id);
      }
      return node;
    });

  const edges = edgesRaw
    .filter((edge) => edge && typeof edge.source === "string" && typeof edge.target === "string")
    .map((edge) => {
      const out = { source: edge.source, target: edge.target };
      if (typeof edge.label === "string" && edge.label) {
        out.label = edge.label;
      }
      return out;
    });

  return { nodes, edges };
}

/**
 * Build a small summary block for a manifest envelope: id, requirement, task
 * count, edge count, wave count. Used by the explorer header so the page
 * makes sense at a glance even before the DAG renders.
 *
 * @param {object} manifest
 * @returns {{id: string, requirement: string, taskCount: number, edgeCount: number, waveCount: number}}
 */
export function summariseManifest(manifest) {
  if (!manifest || typeof manifest !== "object") {
    return { id: "", requirement: "", taskCount: 0, edgeCount: 0, waveCount: 0 };
  }
  const plan = manifest.plan && typeof manifest.plan === "object" ? manifest.plan : {};
  return {
    id: typeof manifest.id === "string" ? manifest.id : "",
    requirement: typeof manifest.requirement === "string" ? manifest.requirement : "",
    taskCount: Array.isArray(plan.tasks) ? plan.tasks.length : 0,
    edgeCount: Array.isArray(plan.edges) ? plan.edges.length : 0,
    waveCount: Array.isArray(plan.waves) ? plan.waves.length : 0
  };
}

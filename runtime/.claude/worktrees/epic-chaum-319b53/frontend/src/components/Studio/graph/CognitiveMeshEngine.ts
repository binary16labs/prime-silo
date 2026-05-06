// Cognitive Mesh Engine
// Graph analysis primitives: degree stats, cycle detection (TDA-lite),
// blast-radius traversal, edge importance scoring.
// All pure, memoizable, no side effects.

export interface MeshNode {
  id: string;
  type: string;
  position?: [number, number, number];
  metadata?: any;
}

export interface MeshEdge {
  source: string;
  target: string;
  type: string;
  metadata?: any;
}

export interface MeshAnalysis {
  degreeMap: Map<string, number>;          // total adjacency
  inDegreeMap: Map<string, number>;
  outDegreeMap: Map<string, number>;
  maxDegree: number;
  edgeImportance: Map<string, number>;     // 0..1 per edge key
  adjacencyOut: Map<string, string[]>;
  adjacencyIn: Map<string, string[]>;
  cycles: string[][];                      // list of node-id loops
  communityCentroids: Map<number, [number, number, number]>;
}

const edgeKey = (e: MeshEdge) => `${e.source}->${e.target}:${e.type}`;

export function analyzeMesh(nodes: MeshNode[], edges: MeshEdge[]): MeshAnalysis {
  const degreeMap = new Map<string, number>();
  const inDegreeMap = new Map<string, number>();
  const outDegreeMap = new Map<string, number>();
  const adjacencyOut = new Map<string, string[]>();
  const adjacencyIn = new Map<string, string[]>();

  for (const n of nodes) {
    degreeMap.set(n.id, 0);
    inDegreeMap.set(n.id, 0);
    outDegreeMap.set(n.id, 0);
    adjacencyOut.set(n.id, []);
    adjacencyIn.set(n.id, []);
  }

  for (const e of edges) {
    if (!degreeMap.has(e.source) || !degreeMap.has(e.target)) continue;
    degreeMap.set(e.source, (degreeMap.get(e.source) || 0) + 1);
    degreeMap.set(e.target, (degreeMap.get(e.target) || 0) + 1);
    outDegreeMap.set(e.source, (outDegreeMap.get(e.source) || 0) + 1);
    inDegreeMap.set(e.target, (inDegreeMap.get(e.target) || 0) + 1);
    adjacencyOut.get(e.source)!.push(e.target);
    adjacencyIn.get(e.target)!.push(e.source);
  }

  let maxDegree = 0;
  degreeMap.forEach(v => { if (v > maxDegree) maxDegree = v; });

  // Edge importance ≈ geometric mean of endpoint degrees, normalized.
  const edgeImportance = new Map<string, number>();
  for (const e of edges) {
    const ds = degreeMap.get(e.source) || 0;
    const dt = degreeMap.get(e.target) || 0;
    const raw = Math.sqrt(ds * dt);
    const norm = maxDegree > 0 ? Math.min(1, raw / maxDegree) : 0;
    // Relationship-type weighting: CALLS/DEPENDS_ON are hot paths
    const typeBoost = e.type === 'CALLS' ? 1.15 : e.type === 'DEPENDS_ON' ? 1.1 : e.type === 'INHERITS' ? 1.05 : 1.0;
    edgeImportance.set(edgeKey(e), Math.min(1, norm * typeBoost));
  }

  // Cycle detection — bounded Johnson-lite, cap search to keep it snappy.
  const cycles = detectCycles(nodes, adjacencyOut, 40, 6);

  // Community centroids (for cluster rotation & nebula placement)
  const communityCentroids = computeCommunityCentroids(nodes);

  return {
    degreeMap,
    inDegreeMap,
    outDegreeMap,
    maxDegree,
    edgeImportance,
    adjacencyOut,
    adjacencyIn,
    cycles,
    communityCentroids,
  };
}

export function getEdgeImportance(analysis: MeshAnalysis, edge: MeshEdge): number {
  return analysis.edgeImportance.get(edgeKey(edge)) ?? 0;
}

// Depth-bounded DFS that records simple cycles. Budget prevents combinatorial blow-up.
function detectCycles(
  nodes: MeshNode[],
  adj: Map<string, string[]>,
  maxCycles: number,
  maxLength: number
): string[][] {
  const cycles: string[][] = [];
  const seen = new Set<string>();

  const dfs = (start: string, current: string, path: string[], depth: number) => {
    if (cycles.length >= maxCycles) return;
    if (depth > maxLength) return;

    const neighbors = adj.get(current) || [];
    for (const next of neighbors) {
      if (next === start && path.length >= 3) {
        const canonical = canonicalCycle([...path, start]);
        const key = canonical.join('→');
        if (!seen.has(key)) {
          seen.add(key);
          cycles.push(canonical);
          if (cycles.length >= maxCycles) return;
        }
        continue;
      }
      if (path.includes(next)) continue;
      dfs(start, next, [...path, next], depth + 1);
    }
  };

  // Only search from a sample of high-degree nodes to bound cost.
  const sorted = [...nodes].sort((a, b) => {
    const da = (adj.get(a.id)?.length || 0);
    const db = (adj.get(b.id)?.length || 0);
    return db - da;
  }).slice(0, 30);

  for (const n of sorted) {
    if (cycles.length >= maxCycles) break;
    dfs(n.id, n.id, [n.id], 0);
  }
  return cycles;
}

function canonicalCycle(nodes: string[]): string[] {
  // Drop duplicate closing node, rotate to start at min id for dedup.
  const core = nodes.slice(0, -1);
  let minIdx = 0;
  for (let i = 1; i < core.length; i++) {
    if (core[i] < core[minIdx]) minIdx = i;
  }
  return [...core.slice(minIdx), ...core.slice(0, minIdx)];
}

function computeCommunityCentroids(nodes: MeshNode[]): Map<number, [number, number, number]> {
  const buckets = new Map<number, { sum: [number, number, number], count: number }>();
  for (const n of nodes) {
    const cid = n.metadata?.community_id;
    if (cid === undefined || cid === null || !n.position) continue;
    const id = Number(cid);
    if (Number.isNaN(id)) continue;
    const b = buckets.get(id) || { sum: [0, 0, 0] as [number, number, number], count: 0 };
    b.sum[0] += n.position[0];
    b.sum[1] += n.position[1];
    b.sum[2] += n.position[2];
    b.count += 1;
    buckets.set(id, b);
  }
  const result = new Map<number, [number, number, number]>();
  buckets.forEach((b, k) => {
    result.set(k, [b.sum[0] / b.count, b.sum[1] / b.count, b.sum[2] / b.count]);
  });
  return result;
}

// --- Blast Radius Traversal ---

export interface BlastRadius {
  downstream: Set<string>;
  upstream: Set<string>;
  downstreamEdges: Set<string>;
  upstreamEdges: Set<string>;
  maxDepth: number;
}

export function computeBlastRadius(
  analysis: MeshAnalysis,
  edges: MeshEdge[],
  startId: string,
  maxDepth = 6
): BlastRadius {
  const downstream = new Set<string>();
  const upstream = new Set<string>();
  const downstreamEdges = new Set<string>();
  const upstreamEdges = new Set<string>();

  // BFS downstream
  const bfs = (
    start: string,
    adj: Map<string, string[]>,
    visited: Set<string>,
    edgeAcc: Set<string>,
    direction: 'out' | 'in'
  ) => {
    const queue: Array<[string, number]> = [[start, 0]];
    visited.add(start);
    while (queue.length) {
      const [cur, depth] = queue.shift()!;
      if (depth >= maxDepth) continue;
      const nexts = adj.get(cur) || [];
      for (const n of nexts) {
        if (!visited.has(n)) {
          visited.add(n);
          queue.push([n, depth + 1]);
        }
        // Record traversed edge
        const src = direction === 'out' ? cur : n;
        const tgt = direction === 'out' ? n : cur;
        for (const e of edges) {
          if (e.source === src && e.target === tgt) {
            edgeAcc.add(edgeKey(e));
          }
        }
      }
    }
  };

  bfs(startId, analysis.adjacencyOut, downstream, downstreamEdges, 'out');
  bfs(startId, analysis.adjacencyIn, upstream, upstreamEdges, 'in');
  downstream.delete(startId);
  upstream.delete(startId);

  return { downstream, upstream, downstreamEdges, upstreamEdges, maxDepth };
}

export { edgeKey };

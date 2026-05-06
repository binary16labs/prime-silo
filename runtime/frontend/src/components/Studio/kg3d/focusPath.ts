import type { KgNode, KgEdge } from '../../../hooks/useKg3dStore';

/**
 * calculateFocusPath - BFS to find nodes within N hops of the target.
 */
export function calculateFocusPath(
  nodes: KgNode[],
  edges: KgEdge[],
  targetId: string | null,
  hops: number = 2
): Set<string> {
  if (!targetId) return new Set();

  const focusIds = new Set<string>([targetId]);
  
  // Simple traversal to gather neighbors up to 'hops'
  let currentLayer = new Set<string>([targetId]);
  for (let i = 0; i < hops; i++) {
    const nextLayer = new Set<string>();
    edges.forEach(edge => {
      if (currentLayer.has(edge.source_id)) {
        nextLayer.add(edge.target_id);
        focusIds.add(edge.target_id);
      }
      if (currentLayer.has(edge.target_id)) {
        nextLayer.add(edge.source_id);
        focusIds.add(edge.source_id);
      }
    });
    currentLayer = nextLayer;
  }

  return focusIds;
}

export function isNodeVisible(node: KgNode, focusIds: Set<string>, pruneThreshold: number): boolean {
  // If no focus, all are visible
  if (focusIds.size === 0) return true;
  
  // Always visible if in focus path
  if (focusIds.has(node.id)) return true;
  
  // Context nodes: visible if above threshold
  return node.metrics.pagerank > pruneThreshold;
}

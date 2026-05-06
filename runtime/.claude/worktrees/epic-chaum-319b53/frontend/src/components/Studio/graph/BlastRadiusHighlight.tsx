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
  if (inDownstream) return '#39FF14';
  if (inUpstream) return '#FF5F1F';
  return base;
}

export { edgeKey };

import React, { useEffect, useRef, useState, useMemo } from 'react';
import ForceGraph3D from 'react-force-graph-3d';
import { CATEGORY_COLORS, EDGE_COLORS } from './palette';
import InstancedNodes from './InstancedNodes';
import { useKg3dStore, type KgNode, type KgEdge, type DeltaEvent } from '../../../hooks/useKg3dStore';
import { API_BASE_URL, GOVERNANCE_HEADERS } from '../../../constants';
import * as THREE from 'three';

interface SynopticWebProps {
  enabled: boolean;
  focusedLayer?: number;
}

// TODO(KG3D-001 Phase 5): replace ForceGraphMethods type usage when API stabilizes
const SynopticWeb: React.FC<SynopticWebProps> = ({ enabled, focusedLayer = null }) => {
  const fgRef = useRef<any>(null);
  const { selectConcept, setGraph } = useKg3dStore();
  const [data, setData] = useState<{ nodes: any[]; links: any[] }>({ nodes: [], links: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Fetch initial ontology
  useEffect(() => {
    if (!enabled) return;

    const fetchOntology = async () => {
      const startTime = performance.now();
      try {
        const res = await fetch(`${API_BASE_URL}/api/kg3d/ontology`, {
          headers: { ...GOVERNANCE_HEADERS }
        });
        if (res.ok) {
          const raw = await res.json();
          if (!raw.nodes || raw.nodes.length === 0) {
            // Fallback mock: 5-layer example graph
            const mockNodes = [
              { id: '1', canonical_name: 'AI', display_name: 'Artificial Intelligence', category: 'ai_deep_learning', aot_layer: 1, metrics: { pagerank: 100, degree: 5, betweenness: 80, descendant_ratio: 0.9, prerequisite_ratio: 0, reachability_ratio: 1 } },
              { id: '2', canonical_name: 'Neural Networks', display_name: 'Neural Networks', category: 'neural_evolutionary_computing', aot_layer: 2, metrics: { pagerank: 80, degree: 8, betweenness: 70, descendant_ratio: 0.7, prerequisite_ratio: 0.1, reachability_ratio: 0.8 } },
              { id: '3', canonical_name: 'Calculus', display_name: 'Calculus', category: 'calc_variations_control', aot_layer: 2, metrics: { pagerank: 75, degree: 6, betweenness: 65, descendant_ratio: 0.6, prerequisite_ratio: 0.2, reachability_ratio: 0.7 } },
              { id: '4', canonical_name: 'Linear Algebra', display_name: 'Linear Algebra', category: 'linear_multilinear_algebra_matrix_theory', aot_layer: 3, metrics: { pagerank: 70, degree: 10, betweenness: 60, descendant_ratio: 0.5, prerequisite_ratio: 0.3, reachability_ratio: 0.6 } },
              { id: '5', canonical_name: 'Backpropagation', display_name: 'Backpropagation', category: 'optimisation_reinforcement_learning', aot_layer: 4, metrics: { pagerank: 60, degree: 4, betweenness: 40, descendant_ratio: 0.2, prerequisite_ratio: 0.8, reachability_ratio: 0.3 } }
            ];
            const mockLinks = [
              { id: 'e1', source_id: '1', target_id: '2', kind: 'prerequisite', weight: 1 },
              { id: 'e2', source_id: '1', target_id: '3', kind: 'prerequisite', weight: 1 },
              { id: 'e3', source_id: '3', target_id: '4', kind: 'prerequisite', weight: 1 },
              { id: 'e4', source_id: '4', target_id: '2', kind: 'references', weight: 0.8 },
              { id: 'e5', source_id: '2', target_id: '5', kind: 'prerequisite', weight: 1 }
            ];
            setData({
              nodes: mockNodes,
              links: mockLinks.map(e => ({ ...e, source: e.source_id, target: e.target_id }))
            });
            setGraph(mockNodes, mockLinks);
            setError(null);
            console.log('[KG3D] Using mock dataset (API returned empty)');
          } else {
            setData({
              nodes: raw.nodes.map((n: KgNode) => ({ ...n })),
              links: raw.edges.map((e: KgEdge) => ({ ...e, source: e.source_id, target: e.target_id }))
            });
            setGraph(raw.nodes, raw.edges);
            const duration = performance.now() - startTime;
            console.log(`[KG3D_TELEMETRY] Ontology loaded in ${duration.toFixed(2)}ms. Nodes: ${raw.nodes.length}`);
            setError(null);
          }
        } else {
          setError(`API error: ${res.status} ${res.statusText}`);
          console.error("API error:", res.status, res.statusText);
        }
      } catch (e: any) {
        setError(`Failed to load ontology: ${e.message || String(e)}`);
        console.error("Failed to load ontology:", e);
      } finally {
        setLoading(false);
      }
    };

    fetchOntology();
  }, [enabled]);

  // SSE Stream for updates
  useEffect(() => {
    if (!enabled) return;

    const eventSource = new EventSource(`${API_BASE_URL}/api/kg3d/stream`);
    
    eventSource.onmessage = (event) => {
      const delta: DeltaEvent = JSON.parse(event.data);
      if (delta.kind === 'upsert_node' && delta.payload) {
        setData(prev => ({
          ...prev,
          nodes: [...prev.nodes.filter(n => n.id !== delta.payload.id), delta.payload]
        }));
      } else if (delta.kind === 'upsert_edge' && delta.payload) {
          setData(prev => ({
            ...prev,
            links: [...prev.links.filter(l => l.id !== delta.payload.id), {
                ...delta.payload,
                source: delta.payload.source_id,
                target: delta.payload.target_id
            }]
          }));
      }
    };

    return () => eventSource.close();
  }, [enabled]);

  // AoT Layer Filtering (Fading)
  const processedData = useMemo(() => {
    if (focusedLayer === null) return data;
    
    return {
      nodes: data.nodes.map(n => ({
        ...n,
        __opacity: n.aot_layer === focusedLayer ? 1.0 : 0.1
      })),
      links: data.links.map(l => ({
        ...l,
        __opacity: 0.2 // Simplified fading for links
      }))
    };
  }, [data, focusedLayer]);

  if (!enabled) return null;

  if (error) {
    return (
      <div className="w-full h-full flex items-center justify-center bg-[#020408]">
        <div className="bg-red-900/20 border border-red-500/40 p-6 rounded max-w-md text-center">
          <div className="text-red-400 font-mono text-sm mb-2">KG3D_ONTOLOGY_ERROR</div>
          <div className="text-white/60 text-xs mb-4">{error}</div>
          <button
            onClick={() => window.location.reload()}
            className="px-4 py-1 bg-red-900/30 border border-red-500/40 text-red-400 text-xs rounded hover:bg-red-900/50"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="synoptic-web-container" style={{ width: '100%', height: '100%', background: '#020408' }}>
      {loading && (
        <div className="absolute inset-0 flex items-center justify-center text-[#39FF14] font-mono text-sm">
          SYNOPTIC_WEB_LOADING...
        </div>
      )}
      <ForceGraph3D
        ref={fgRef}
        graphData={processedData}
        backgroundColor="#020408"
        nodeLabel="display_name"
        nodeColor={(n: any) => CATEGORY_COLORS[n.category] || CATEGORY_COLORS.default}
        nodeRelSize={6}
        nodeVal={(n: any) => n.metrics.pagerank * 100 + 1}
        nodeOpacity={1}
        nodeY={(n: any) => {
          // Vertical depth by abstraction layer (KG3D-F13): layer 1 (abstract) at top, layer 5 (concrete) at bottom
          const layer = n.aot_layer || 3;
          return (5 - layer) * 50; // Layer 1 = +200, Layer 5 = 0
        }}
        nodeThreeObject={(n: any) => {
            // TODO(KG3D-001 Phase 5): re-introduce instanced custom layer
            return undefined;
        }}
        linkColor={(l: any) => EDGE_COLORS[l.kind] || EDGE_COLORS.references}
        linkWidth={(l: any) => l.kind === 'prerequisite' ? 2.5 : 1}
        linkOpacity={0.6}
        linkDirectionalParticles={(l: any) => l.kind === 'prerequisite' ? 3 : 0}
        linkDirectionalParticleSpeed={0.015}
        linkCurveRotation={0.3}
        showNavInfo={false}
        onNodeClick={(node: any) => {
          selectConcept(node.id);
          console.log("Focused concept:", node.canonical_name);
        }}
      />
    </div>
  );
};

export { SynopticWeb };
export default SynopticWeb;

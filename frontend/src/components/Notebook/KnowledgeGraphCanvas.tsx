import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import ForceGraph3D from '3d-force-graph';
import { Share2, Zap, Clock, AlertTriangle, RefreshCw, Maximize2, Minimize2, Search, Download, ChevronRight, Layers, Eye } from 'lucide-react';
import { API_BASE_URL, GOVERNANCE_HEADERS } from '../../constants';
import { useWorkspaceStore } from '../../hooks/useWorkspaceStore';
import { useWorkflowStore } from '../../hooks/useWorkflowStore';

interface GraphNode {
  id: string;
  name: string;
  labels: string[];
  domain: string;
  node_type?: string;
  created_at: string;
  centrality?: number;
  x?: number;
  y?: number;
  z?: number;
}

interface GraphEdge {
  source: string;
  target: string;
  type: string;
  predicate: string;
  description: string;
  pattern: string;
  source_doc: string;
  section?: string;
  citation?: string;
  confidence?: number;
  created_at: string;
  timestamp: string;
  run_id?: string;
}

interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
  total_nodes?: number;
  has_more?: boolean;
  page?: number | null;
}

interface KnowledgeGraphCanvasProps {
  onConceptClick?: (concept: string) => void;
  workspace?: string;
  refreshTrigger?: number;
}

const EDGE_COLORS: Record<string, string> = {
  RELATES_TO: '#8b5cf6',      // Purple
  SOURCED_FROM: '#6366f1',    // Indigo
  CONFLICTS_WITH: '#ef4444',  // Red
  ANALOGOUS_TO: '#f59e0b',    // Amber
  REPRESENTS: '#10b981',      // Emerald
  CORRELATES_WITH: '#3b82f6', // Blue
  CODE_REL: '#6b7280',        // Gray
  DEFINES: '#ec4899',         // Pink
  CALLS: '#f97316',           // Orange
  INHERITS: '#84cc16',        // Lime
  DEPENDS_ON: '#06b6d4',      // Cyan
  CONTAINS: '#64748b',        // Slate
};

// Dynamic color assignments for Entity Typing Category Maps
const NODE_COLORS: Record<string, string> = {
  Concept: '#a56eff',
  Source: '#4dbbff',
  Document: '#4dbbff',
  CodeEntity: '#94a3b8',
  File: '#64748b',
  Folder: '#475569',
  Class: '#ec4899',
  Function: '#f97316',
  Interface: '#8b5cf6',
  Theory: '#ff9f0a',
  Technology: '#34c759',
  Person: '#ff3b30',
  Organization: '#007aff',
  Event: '#ffcc00',
  Location: '#ff375f'
};

// Performance threshold: switch to low-fidelity rendering above this
const PERFORMANCE_NODE_THRESHOLD = 500;

export default function KnowledgeGraphCanvas({ onConceptClick, workspace = 'default', refreshTrigger }: KnowledgeGraphCanvasProps) {
  const { activeGraphId } = useWorkspaceStore() as any;
  const { 
    synthesisMode, 
    cognitiveMesh, 
    visibleTypes, 
    visibleEdgeTypes,
    showClusters 
  } = useWorkflowStore();
  const containerRef = useRef<HTMLDivElement>(null);
  const graphRef = useRef<any>(null);
  const [graphData, setGraphData] = useState<GraphData>({ nodes: [], edges: [] });
  const [stats, setStats] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [selectedNode, setSelectedNode] = useState<any | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; node: any } | null>(null);
  const [viewMode, setViewMode] = useState<'graph' | 'map'>('graph');
  const [showAll, setShowAll] = useState(false);
  const [currentPage, setCurrentPage] = useState(0);
  const PAGE_SIZE = 200;
  
  // Filtering & Isolation States
  const [searchQuery, setSearchQuery] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const searchTimerRef = useRef<any>(null);
  
  // Node Detail Sidebar
  const [detailNode, setDetailNode] = useState<any | null>(null);
  const [nodeEdges, setNodeEdges] = useState<GraphEdge[]>([]);

  const focusRef = useRef({ 
    node: null as GraphNode | null, 
    search: '', 
    links: new Set<any>(), 
    neighbors: new Set<string>() 
  });

  // Debounced search — prevent excessive WebGL repaints  
  useEffect(() => {
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    searchTimerRef.current = setTimeout(() => {
      setDebouncedSearch(searchQuery);
    }, 300);
    return () => clearTimeout(searchTimerRef.current);
  }, [searchQuery]);

  // Performance checks
  const isLargeGraph = useMemo(() => graphData.nodes.length > PERFORMANCE_NODE_THRESHOLD, [graphData.nodes.length]);

  const fetchGraph = useCallback(async (page?: number, fetchAll?: boolean) => {
    setLoading(true);
    try {
      const timestamp = Date.now();
      const runParam = activeGraphId && activeGraphId !== 'neural_nexus'
        ? `&run_id=${activeGraphId}`
        : '';
      let graphUrl = `${API_BASE_URL}/api/graph/full?workspace=${workspace}&t=${timestamp}${runParam}`;
      
      if (fetchAll) {
        graphUrl += `&show_all=true`;
      } else if (page !== undefined) {
        graphUrl += `&page=${page}&page_size=${PAGE_SIZE}`;
      }

      const [graphRes, statsRes] = await Promise.all([
        fetch(graphUrl, {
          headers: { ...GOVERNANCE_HEADERS }
        }),
        fetch(`${API_BASE_URL}/api/graph/stats?workspace=${workspace}&t=${timestamp}`, {
          headers: { ...GOVERNANCE_HEADERS }
        })
      ]);

      if (graphRes.ok) {
        const data = await graphRes.json();
        // Compute degree (edge count) per node and inject it before storing
        const degreeMap: Record<string, number> = {};
        for (const edge of (data.edges || [])) {
          const s = String(edge.source);
          const t = String(edge.target);
          degreeMap[s] = (degreeMap[s] || 0) + 1;
          degreeMap[t] = (degreeMap[t] || 0) + 1;
        }
        data.nodes = (data.nodes || []).map((n: any) => ({ ...n, degree: degreeMap[n.id] || 0 }));
        setGraphData(data);
      }
      if (statsRes.ok) {
        const data = await statsRes.json();
        setStats(data);
      }
    } catch (err) {
      console.error('Failed to fetch graph:', err);
    } finally {
      setLoading(false);
    }
  }, [workspace, activeGraphId]);

  // SSE real-time updates — replaces polling
  useEffect(() => {
    // Listen for custom events from the SynthesisPanel when a new ingestion starts
    const handleIngestionSSE = (e: CustomEvent) => {
      const { run_id } = e.detail;
      if (!run_id) return;

      const eventSource = new EventSource(`${API_BASE_URL}/api/graph/ingest/events/${run_id}`);
      
      eventSource.addEventListener('stored', () => {
        // Refresh graph when new triples are stored
        fetchGraph(showAll ? undefined : currentPage, showAll);
      });

      eventSource.addEventListener('centrality_updated', () => {
        fetchGraph(showAll ? undefined : currentPage, showAll);
      });

      eventSource.addEventListener('completed', () => {
        fetchGraph(showAll ? undefined : currentPage, showAll);
        eventSource.close();
      });

      eventSource.addEventListener('error', () => {
        eventSource.close();
      });

      eventSource.onerror = () => {
        eventSource.close();
      };
    };

    window.addEventListener('benny:ingestion-started' as any, handleIngestionSSE as any);
    return () => window.removeEventListener('benny:ingestion-started' as any, handleIngestionSSE as any);
  }, [fetchGraph, showAll, currentPage]);

  // Initial load
  useEffect(() => {
    fetchGraph();
  }, [fetchGraph]);

  // Respond to external refresh triggers
  useEffect(() => {
    if (refreshTrigger) {
      fetchGraph(showAll ? undefined : currentPage, showAll);
    }
  }, [refreshTrigger]);

  // Propagate search & select states into the active ref immediately to restyle WebGL dynamically
  useEffect(() => {
    if (!graphRef.current) return;
    
    focusRef.current.search = debouncedSearch.toLowerCase();
    focusRef.current.node = selectedNode;
    focusRef.current.neighbors.clear();
    focusRef.current.links.clear();

    if (selectedNode) {
      focusRef.current.neighbors.add(selectedNode.id);
      graphData.edges.forEach((edge: any) => {
        if (edge.source.id === selectedNode.id || edge.target.id === selectedNode.id) {
          focusRef.current.neighbors.add(edge.source.id);
          focusRef.current.neighbors.add(edge.target.id);
          focusRef.current.links.add(edge);
        }
      });
    }

    graphRef.current
      .nodeColor(graphRef.current.nodeColor())
      .linkColor(graphRef.current.linkColor())
      .nodeOpacity(graphRef.current.nodeOpacity())
      .linkOpacity(graphRef.current.linkOpacity());
  }, [debouncedSearch, selectedNode, graphData, synthesisMode, cognitiveMesh, visibleTypes, visibleEdgeTypes, showClusters]);

  // Node detail sidebar — compute connected edges when a node is selected for detail
  useEffect(() => {
    if (!detailNode) {
      setNodeEdges([]);
      return;
    }
    const connected = graphData.edges.filter((e: any) => {
      const src = typeof e.source === 'object' ? e.source.id : e.source;
      const tgt = typeof e.target === 'object' ? e.target.id : e.target;
      return src === detailNode.id || tgt === detailNode.id;
    });
    setNodeEdges(connected);
  }, [detailNode, graphData.edges]);

  // Render 3D force graph
  useEffect(() => {
    if (!containerRef.current || graphData.nodes.length === 0) return;

    if (graphRef.current) {
      graphRef.current._destructor?.();
      containerRef.current.innerHTML = '';
    }

    const ForceGraph3D_Lib = (ForceGraph3D as any).default || ForceGraph3D;
    const graph = (ForceGraph3D_Lib)()(containerRef.current)
      .backgroundColor('rgba(0,0,0,0)')
      
      // Node Coloring with Entity Typing & Mode Overlay
      .nodeColor((node: any) => {
        if (focusRef.current.search && !node.name.toLowerCase().includes(focusRef.current.search)) return '#1f2937';
        if (focusRef.current.node && !focusRef.current.neighbors.has(node.id)) return '#1f2937';
        
        const typeLabel = node.node_type || (node.labels || [])[0] || 'Concept';
        
        // Mode-based dimming
        if (synthesisMode === 'structural' && !['Folder', 'File'].includes(typeLabel)) return '#1f2937';
        if (synthesisMode === 'neural' && ['Folder', 'File'].includes(typeLabel)) return '#111827';

        return NODE_COLORS[typeLabel] || NODE_COLORS['Concept'];
      })
      
      // Node Opacity & Highlighting
      .nodeOpacity((node: any) => {
         if (focusRef.current.search && !node.name.toLowerCase().includes(focusRef.current.search)) return 0.05;
         if (focusRef.current.node && !focusRef.current.neighbors.has(node.id)) return 0.1;
         
         const typeLabel = node.node_type || (node.labels || [])[0] || 'Concept';
         
         // Synthesis Mode Alpha Blending
         if (synthesisMode === 'structural' && !['Folder', 'File'].includes(typeLabel)) return 0.2;
         if (synthesisMode === 'neural' && ['Folder', 'File'].includes(typeLabel)) return 0.1;

         return 0.95;
      })
      
      .nodeLabel((node: any) => {
        const typeLabel = node.node_type || (node.labels || [])[0] || 'Concept';
        return `<div style="background:rgba(15,15,30,0.9);padding:6px 10px;border-radius:6px;color:#e2e8f0;font-size:12px;border:1px solid rgba(139,92,246,0.3)">
          <strong>${node.name}</strong><br/>
          <span style="opacity:0.7">${typeLabel}</span>
        </div>`;
      })
      .nodeVal((node: any) => {
        const typeLabel = node.node_type || (node.labels || [])[0] || 'Concept';
        
        // Scale nodes based on hierarchy or degree
        let baseSize = 6;
        if (typeLabel === 'Folder') baseSize = 12;
        if (typeLabel === 'File') baseSize = 8;
        if (typeLabel === 'Source' || typeLabel === 'Document') baseSize = 4;
        
        const centralityBonus = node.centrality ? Math.log10(node.centrality + 1) * 8 : 0;
        const degreeBonus = (cognitiveMesh.degreeSizing && node.degree) ? Math.log1p(node.degree) * 4 : 0;
        
        return baseSize + centralityBonus + degreeBonus;
      })
      
      // Organic Link Curvature (Structural Backbone vs Semantic Cloud)
      .linkCurvature((link: any) => {
        if (synthesisMode === 'architectural') {
          // Hierarchy is straight, semantics are curved
          if (['CONTAINS', 'DEFINES'].includes(link.type)) return 0;
          return 0.35;
        }
        return 0.25;
      })
      .linkCurveRotation(Math.PI / 4)
      
      // Edge Style Logic & Confidence Dampening
      .linkColor((link: any) => {
         if (focusRef.current.node && !focusRef.current.links.has(link)) return '#1f2937';
         
         // Myelination Effect (Glow for high-confidence/important links)
         if (cognitiveMesh.myelination && link.confidence > 0.8) {
           return '#ffffff'; // Emissive white
         }

         return EDGE_COLORS[link.type] || '#4a5568';
      })
      .linkOpacity((link: any) => {
         if (focusRef.current.node && !focusRef.current.links.has(link)) return 0.05;
         
         // Synthesis Mode Edge Masking
         if (synthesisMode === 'structural' && !['CONTAINS', 'DEFINES'].includes(link.type)) return 0.05;
         
         const baseOpacity = link.confidence !== undefined ? Math.max(0.2, link.confidence) : 0.6;
         return baseOpacity;
      })
      .linkWidth((link: any) => {
        let width = focusRef.current.links.has(link) ? 2.5 : 1.2;
        if (['CONTAINS', 'DEFINES'].includes(link.type)) width *= 1.5; // Thicker structural lines
        return width;
      })
      .linkDirectionalArrowLength((link: any) => (focusRef.current.node && !focusRef.current.links.has(link) ? 0 : 4))
      .linkDirectionalArrowRelPos(1)
      
      // Interactive Citation Hover Details
      .linkLabel((link: any) => {
        const citationStr = link.citation ? `<div style="margin-top:4px; font-style:italic; font-size:10px; opacity:0.8; max-width:200px; white-space:normal">"${link.citation}"</div>` : '';
        const sectionStr = link.section ? `<div style="margin-top:2px; font-size:9px; color:#a78bfa">${link.section}</div>` : '';
        const confStr = link.confidence !== undefined ? `<div style="margin-top:4px; font-size:9px; color:#10b981">Confidence: ${Math.round(link.confidence * 100)}%</div>` : '';
        
        return `<div style="background:rgba(15,15,30,0.95);padding:6px 10px;border-radius:6px;color:#e2e8f0;font-size:11px;border:1px solid rgba(99,102,241,0.4);max-width:220px">
          <strong>${link.predicate || link.type}</strong>
          ${confStr}
          ${sectionStr}
          ${citationStr}
        </div>`;
      })
      
      .onNodeClick((node: any) => {
        setSelectedNode(node);
        setDetailNode(node);
        if (onConceptClick) onConceptClick(node.name);
        
        // Dynamic camera zoom
        const distance = 150;
        const distRatio = 1 + distance / Math.hypot(node.x, node.y, node.z);
        graphRef.current.cameraPosition(
          { x: node.x * distRatio, y: (node.y || 0) * distRatio, z: (node.z || 0) * distRatio },
          node, 1500
        );
      })
      .onNodeRightClick((node: any, event: MouseEvent) => {
        event.preventDefault();
        setContextMenu({ x: event.clientX, y: event.clientY, node: node });
      })
      .onBackgroundClick(() => {
         setSelectedNode(null);
         setDetailNode(null);
      })
      .width(containerRef.current.clientWidth)
      .height(containerRef.current.clientHeight);

    // Performance guards & Cognitive Mesh: Dynamic Particle Flow
    if (isLargeGraph && !cognitiveMesh.dataFlowParticles) {
      graph
        .linkDirectionalParticles(0)
        .nodeResolution(6);  // Lower polygon count
    } else {
      graph
        .linkDirectionalParticles((link: any) => {
          if (focusRef.current.links.has(link)) return 4;
          if (!cognitiveMesh.dataFlowParticles) return 0;
          
          // Show particles for high-confidence semantic links in Architectural mode
          if (synthesisMode === 'architectural' && !['CONTAINS', 'DEFINES'].includes(link.type)) {
            return Math.ceil(cognitiveMesh.particleDensity * 2);
          }
          return 0;
        })
        .linkDirectionalParticleSpeed(0.01 * cognitiveMesh.particleDensity)
        .nodeResolution(isLargeGraph ? 8 : 12);
    }

    // Map Mode: Flatten Z-axis for the "Atlas" feel
    if (viewMode === 'map') {
      graph.numDimensions(2);
    } else {
      graph.numDimensions(3);
    }

    const links = graphData.edges.map(e => ({ ...e, source: e.source, target: e.target }));

    graph.graphData({
      nodes: graphData.nodes.map(n => ({ ...n })),
      links
    });

    graphRef.current = graph;

    const resizeObserver = new ResizeObserver(() => {
      if (containerRef.current) {
        graph.width(containerRef.current.clientWidth);
        graph.height(containerRef.current.clientHeight);
      }
    });
    resizeObserver.observe(containerRef.current);

    return () => resizeObserver.disconnect();
  }, [graphData, onConceptClick, viewMode, isLargeGraph]);

  const handleCrossDomain = async (concept: string, domain: string) => {
    setContextMenu(null);
    try {
      const res = await fetch(`${API_BASE_URL}/api/graph/cross-domain`, {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          ...GOVERNANCE_HEADERS
        },
        body: JSON.stringify({ concept, target_domain: domain, workspace })
      });
      if (res.ok) {
        const data = await res.json();
        alert(`Cross-Domain Result:\n\n${JSON.stringify(data.result, null, 2)}`);
      }
    } catch (err) {
      console.error('Cross-domain analogy failed:', err);
    }
  };

  // Export handlers
  const handleExportJSON = () => {
    const blob = new Blob([JSON.stringify(graphData, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `knowledge-graph-${workspace}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleExportPNG = () => {
    if (!containerRef.current) return;
    const canvas = containerRef.current.querySelector('canvas');
    if (!canvas) return;
    const url = canvas.toDataURL('image/png');
    const a = document.createElement('a');
    a.href = url;
    a.download = `knowledge-graph-${workspace}.png`;
    a.click();
  };

  // Pagination handlers
  const handleNextPage = () => {
    const nextPage = currentPage + 1;
    setCurrentPage(nextPage);
    fetchGraph(nextPage, false);
  };

  const handlePrevPage = () => {
    if (currentPage > 0) {
      const prevPage = currentPage - 1;
      setCurrentPage(prevPage);
      fetchGraph(prevPage, false);
    }
  };

  const handleShowAll = () => {
    setShowAll(true);
    fetchGraph(undefined, true);
  };

  const handleShowPaginated = () => {
    setShowAll(false);
    setCurrentPage(0);
    fetchGraph(0, false);
  };

  return (
    <div className={`knowledge-graph-canvas ${isFullscreen ? 'fullscreen' : ''}`}>
      {/* Interactive Toolbar */}
      <div className="graph-toolbar" style={{ display: 'flex', justifyContent: 'space-between' }}>
        <div className="graph-toolbar-left" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <Share2 size={14} style={{ color: 'var(--primary)' }} />
          <span className="graph-toolbar-title">Knowledge Graph</span>
          
          <div style={{ marginLeft: '12px', display: 'flex', alignItems: 'center', background: 'rgba(0,0,0,0.15)', border: '1px solid var(--border-color)', borderRadius: '6px', padding: '2px 8px' }}>
             <Search size={12} style={{ opacity: 0.5, marginRight: '6px' }} />
             <input 
               type="text" 
               placeholder="Search cluster..." 
               value={searchQuery}
               onChange={(e) => setSearchQuery(e.target.value)}
               style={{ background: 'transparent', border: 'none', color: 'var(--text-primary)', fontSize: '11px', outline: 'none', width: '120px' }}
             />
          </div>
          
          {stats && (
            <span className="graph-toolbar-stats" style={{ marginLeft: '8px' }}>
              {stats.concepts} concepts · {stats.relationships} relations
              {graphData.total_nodes && graphData.total_nodes > graphData.nodes.length && !showAll && (
                <span style={{ color: 'var(--warning)', marginLeft: '4px' }}>
                  (showing {graphData.nodes.length}/{graphData.total_nodes})
                </span>
              )}
            </span>
          )}
        </div>
        <div className="graph-toolbar-right" style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
          {/* View mode toggle */}
          <div style={{ display: 'flex', background: 'rgba(0,0,0,0.2)', borderRadius: 'var(--radius-pill)', padding: '4px', border: '1px solid var(--border-color)' }}>
            <button 
              onClick={() => setViewMode('graph')}
              style={{
                padding: '4px 12px',
                borderRadius: 'var(--radius-pill)',
                border: 'none',
                background: viewMode === 'graph' ? 'var(--branch-purple)' : 'transparent',
                color: viewMode === 'graph' ? '#fff' : 'var(--text-muted)',
                fontSize: '11px',
                fontWeight: 600,
                cursor: 'pointer'
              }}
            >
              Graph
            </button>
            <button 
              onClick={() => setViewMode('map')}
              style={{
                padding: '4px 12px',
                borderRadius: 'var(--radius-pill)',
                border: 'none',
                background: viewMode === 'map' ? 'var(--branch-teal)' : 'transparent',
                color: viewMode === 'map' ? '#fff' : 'var(--text-muted)',
                fontSize: '11px',
                fontWeight: 600,
                cursor: 'pointer'
              }}
            >
              Map
            </button>
          </div>

          {/* Pagination / Show All toggle */}
          <div style={{ display: 'flex', background: 'rgba(0,0,0,0.2)', borderRadius: 'var(--radius-pill)', padding: '4px', border: '1px solid var(--border-color)' }}>
            <button
              onClick={showAll ? handleShowPaginated : handleShowAll}
              style={{
                padding: '4px 10px',
                borderRadius: 'var(--radius-pill)',
                border: 'none',
                background: showAll ? 'var(--branch-teal)' : 'transparent',
                color: showAll ? '#fff' : 'var(--text-muted)',
                fontSize: '10px',
                fontWeight: 600,
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                gap: '4px'
              }}
              title={showAll ? 'Switch to paginated view' : 'Show all nodes'}
            >
              {showAll ? <Layers size={10} /> : <Eye size={10} />}
              {showAll ? 'Paginated' : 'All'}
            </button>
          </div>

          {/* Page navigation (only in paginated mode) */}
          {!showAll && graphData.has_more !== undefined && (
            <div style={{ display: 'flex', gap: '2px', alignItems: 'center' }}>
              <button 
                className="btn-icon btn-ghost" 
                onClick={handlePrevPage} 
                disabled={currentPage === 0}
                title="Previous page"
                style={{ opacity: currentPage === 0 ? 0.3 : 1, transform: 'rotate(180deg)' }}
              >
                <ChevronRight size={12} />
              </button>
              <span style={{ fontSize: '10px', color: 'var(--text-muted)', minWidth: '20px', textAlign: 'center' }}>
                {currentPage + 1}
              </span>
              <button 
                className="btn-icon btn-ghost" 
                onClick={handleNextPage} 
                disabled={!graphData.has_more}
                title="Next page"
                style={{ opacity: !graphData.has_more ? 0.3 : 1 }}
              >
                <ChevronRight size={12} />
              </button>
            </div>
          )}

          {/* Export buttons */}
          <button className="btn-icon btn-ghost" onClick={handleExportPNG} title="Export as PNG">
            <Download size={14} />
          </button>

          <button className="btn-icon btn-ghost" onClick={() => fetchGraph(showAll ? undefined : currentPage, showAll)} title="Refresh">
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
          </button>
          <button className="btn-icon btn-ghost" onClick={() => setIsFullscreen(!isFullscreen)} title="Toggle Fullscreen">
            {isFullscreen ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
          </button>
        </div>
      </div>

      <div ref={containerRef} className="graph-3d-container" onClick={() => setContextMenu(null)} />

      {/* Performance warning */}
      {isLargeGraph && (
        <div style={{
          position: 'absolute', top: '48px', left: '12px',
          background: 'rgba(245, 158, 11, 0.15)', border: '1px solid rgba(245, 158, 11, 0.3)',
          padding: '4px 10px', borderRadius: '6px', fontSize: '10px', color: '#f59e0b'
        }}>
          <AlertTriangle size={10} style={{ marginRight: '4px' }} />
          Large graph ({graphData.nodes.length} nodes) — particles disabled for performance
        </div>
      )}

      {graphData.nodes.length === 0 && !loading && (
        <div className="graph-empty-state">
          <Share2 size={32} style={{ opacity: 0.4 }} />
          <p>No knowledge graph yet</p>
          <span>Ingest text to build the relational graph</span>
        </div>
      )}

      {/* Semantic Legend */}
      <div className="graph-legend" style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', maxWidth: '400px' }}>
        {Object.entries(NODE_COLORS).map(([type, color]) => (
           <div key={type} className="legend-item" style={{ cursor: 'pointer' }} onClick={() => setSearchQuery(searchQuery === type ? '' : type)}>
             <span className="legend-dot" style={{ background: color }} />
             <span style={{ opacity: debouncedSearch && debouncedSearch.toLowerCase() !== type.toLowerCase() ? 0.5 : 1 }}>{type}</span>
           </div>
        ))}
      </div>

      {/* Context Menu */}
      {contextMenu && (
        <div className="graph-context-menu" style={{ left: contextMenu.x, top: contextMenu.y }}>
          <div className="context-menu-title">{contextMenu.node.name}</div>
          <button onClick={() => handleCrossDomain(contextMenu.node.name, 'Physics')}><Zap size={12} /> Show in Physics</button>
          <button onClick={() => handleCrossDomain(contextMenu.node.name, 'Biology')}><Zap size={12} /> Show in Biology</button>
          <button onClick={() => handleCrossDomain(contextMenu.node.name, 'Economics')}><Zap size={12} /> Show in Economics</button>
          <button onClick={() => { setContextMenu(null); handleExportJSON(); }}><Download size={12} /> Export Graph JSON</button>
          <button onClick={() => setContextMenu(null)}><AlertTriangle size={12} /> View Conflicts</button>
        </div>
      )}

      {/* Node Detail Sidebar */}
      {detailNode && (
        <div className="graph-node-detail-sidebar" style={{
          position: 'absolute', right: '12px', top: '48px', bottom: '48px',
          width: '280px', background: 'rgba(15, 15, 20, 0.97)',
          border: '1px solid var(--border-color)', borderRadius: '12px',
          backdropFilter: 'blur(12px)', overflow: 'auto', padding: '16px',
          display: 'flex', flexDirection: 'column', gap: '12px'
        }}>
          {/* Header */}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
            <div>
              <strong style={{ fontSize: '15px', color: 'var(--primary)', display: 'block', marginBottom: '4px' }}>
                {detailNode.name}
              </strong>
              <span style={{
                background: 'rgba(139,92,246,0.1)', padding: '2px 8px', borderRadius: '4px',
                fontSize: '10px', color: '#a78bfa'
              }}>
                {detailNode.node_type || (detailNode.labels || [])[0] || 'Concept'}
              </span>
            </div>
            <button
              className="btn-ghost"
              onClick={() => { setDetailNode(null); setSelectedNode(null); }}
              style={{ padding: '4px', fontSize: '16px', lineHeight: 1 }}
            >×</button>
          </div>

          {/* Centrality Score */}
          {detailNode.centrality !== undefined && detailNode.centrality > 0 && (
            <div style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>
              <span style={{ color: 'var(--text-muted)' }}>Centrality:</span>{' '}
              <span style={{ color: '#10b981', fontWeight: 600 }}>{detailNode.centrality.toFixed(2)}</span>
            </div>
          )}

          {/* Connected Edges */}
          <div>
            <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginBottom: '6px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.5px' }}>
              Connections ({nodeEdges.length})
            </div>
            <div style={{ maxHeight: '240px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '6px' }}>
              {nodeEdges.map((edge, idx) => {
                const srcName = typeof edge.source === 'object' ? (edge.source as any).name : edge.source;
                const tgtName = typeof edge.target === 'object' ? (edge.target as any).name : edge.target;
                const otherName = srcName === detailNode.name ? tgtName : srcName;
                const direction = srcName === detailNode.name ? '→' : '←';

                return (
                  <div key={idx} style={{
                    padding: '6px 8px', background: 'rgba(139,92,246,0.06)',
                    borderRadius: '6px', border: '1px solid rgba(139,92,246,0.12)',
                    fontSize: '11px'
                  }}>
                    <div style={{ color: 'var(--text-primary)' }}>
                      {direction} <strong style={{ color: '#a78bfa' }}>{edge.predicate || edge.type}</strong> {otherName}
                    </div>
                    {edge.confidence !== undefined && (
                      <div style={{ fontSize: '9px', color: '#10b981', marginTop: '2px' }}>
                        Confidence: {Math.round(edge.confidence * 100)}%
                      </div>
                    )}
                    {edge.citation && (
                      <div style={{ fontSize: '9px', color: 'var(--text-muted)', marginTop: '2px', fontStyle: 'italic' }}>
                        "{edge.citation.substring(0, 80)}{edge.citation.length > 80 ? '...' : ''}"
                      </div>
                    )}
                  </div>
                );
              })}
              {nodeEdges.length === 0 && (
                <div style={{ fontSize: '10px', color: 'var(--text-muted)', fontStyle: 'italic' }}>
                  No connections found
                </div>
              )}
            </div>
          </div>

          {/* Source Documents */}
          {nodeEdges.some(e => e.source_doc) && (
            <div>
              <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginBottom: '6px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                Source Documents
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px' }}>
                {[...new Set(nodeEdges.map(e => e.source_doc).filter(Boolean))].map(src => (
                  <span key={src} style={{
                    padding: '2px 8px', background: 'rgba(99,102,241,0.1)',
                    borderRadius: '12px', fontSize: '10px', color: '#818cf8'
                  }}>
                    {src}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Actions */}
          <div style={{ marginTop: 'auto', display: 'flex', gap: '6px' }}>
            <button
              className="btn btn-ghost"
              style={{ flex: 1, fontSize: '10px', padding: '6px' }}
              onClick={() => {
                setSelectedNode(null);
                setDetailNode(null);
              }}
            >
              Reset View
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

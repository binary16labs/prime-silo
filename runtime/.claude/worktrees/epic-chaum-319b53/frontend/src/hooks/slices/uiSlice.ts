export type UIVersion = 'v1' | 'v2';
export type ViewMode = 'swarm' | 'knowledge' | 'marketplace' | 'llm' | 'graph' | 'documents';

export interface UISlice {
  isAuditHubOpen: boolean;
  isWikiHubOpen: boolean;
  activeWikiConcept: string | null;
  uiVersion: UIVersion;
  playbackIndex: number | null;
  viewMode: ViewMode;
  codeGraph: { nodes: any[], edges: any[] } | null;
  isCodeGraphScanOpen: boolean;
  isGraphManagerOpen: boolean;
  
  // Graph Control State
  selectionTier: 1 | 2 | 3;
  synthesisMode: 'structural' | 'architectural' | 'neural';
  syncMode: 'real_time' | 'streaming' | 'stabilized';
  visibleTypes: string[];
  visibleEdgeTypes: string[];
  showClusters: boolean;
  graphRenderSettings: {
    starCount: number;
    enableNodeRotation: boolean;
    fpsCap: number;
    enableFreeRotation: boolean;
  };

  // Cognitive Mesh (v2.1) — Spatial IDE feature toggles
  cognitiveMesh: {
    semanticZoom: boolean;          // distance-based representation morphing
    degreeSizing: boolean;          // scale nodes by connection count
    myelination: boolean;           // thicken/glow hot edges
    synapticPruning: boolean;       // fade low-importance elements
    blastRadius: boolean;           // illuminate downstream on select
    dataFlowParticles: boolean;     // animated particles along edges
    cycleDetection: boolean;        // TDA loop highlighting
    neuralNebula: boolean;          // cluster particle clouds
    clusterRotation: boolean;       // galactic slow rotation
    agentOrbit: boolean;            // agents orbiting selection
    agenticPanels: boolean;         // declarative contextual overlays
    timeTravelOpen: boolean;        // scrubber visible
    sonification: boolean;          // WebAudio cues
    ambientHeartbeat: boolean;      // continuous ambient tone
    foveatedLOD: boolean;           // simplify peripheral nodes
    bloomIntensity: number;         // 0..2 emissive multiplier
    pruneThreshold: number;         // 0..1 importance cutoff
    particleDensity: number;        // 0..3
    timeScrubIndex: number;         // 0..snapshots-1
    timeCompression: number;        // 1..64x
  };

  setAuditHubOpen: (isOpen: boolean) => void;
  toggleAuditHub: () => void;
  setWikiHubOpen: (isOpen: boolean) => void;
  setActiveWikiConcept: (concept: string | null) => void;
  setUIVersion: (version: UIVersion) => void;
  toggleUIVersion: () => void;
  setPlaybackIndex: (index: number | null) => void;
  setViewMode: (mode: ViewMode) => void;
  setCodeGraph: (graph: { nodes: any[], edges: any[] } | null) => void;
  setIsCodeGraphScanOpen: (isOpen: boolean) => void;
  setIsGraphManagerOpen: (isOpen: boolean) => void;
  
  // Graph Control Actions
  setSelectionTier: (tier: 1 | 2 | 3) => void;
  setSynthesisMode: (mode: 'structural' | 'architectural' | 'neural') => void;
  setSyncMode: (mode: 'real_time' | 'streaming' | 'stabilized') => void;
  setVisibleTypes: (types: string[]) => void;
  setVisibleEdgeTypes: (types: string[]) => void;
  toggleShowClusters: () => void;
  setStarCount: (count: number) => void;
  setEnableNodeRotation: (enabled: boolean) => void;
  setFpsCap: (fps: number) => void;
  setEnableFreeRotation: (enabled: boolean) => void;

  // Cognitive Mesh actions
  toggleCognitiveMesh: (key: keyof UISlice['cognitiveMesh']) => void;
  setCognitiveMeshValue: <K extends keyof UISlice['cognitiveMesh']>(key: K, value: UISlice['cognitiveMesh'][K]) => void;
}

export const createUISlice = (set: any, get: any): UISlice => ({
  isAuditHubOpen: false,
  isWikiHubOpen: false,
  activeWikiConcept: null,
  uiVersion: 'v2',
  playbackIndex: null,
  viewMode: 'swarm',
  codeGraph: null,
  isCodeGraphScanOpen: false,
  isGraphManagerOpen: false,
  
  // Default Graph State
  selectionTier: 1,
  synthesisMode: 'neural',
  syncMode: 'streaming',
  visibleTypes: ['Folder', 'File', 'Class', 'Interface', 'Function', 'Documentation', 'Concept'],
  visibleEdgeTypes: ['DEFINES', 'INHERITS', 'DEPENDS_ON', 'CALLS', 'CONTAINS', 'REL'],
  showClusters: false,
  graphRenderSettings: {
    starCount: 1000,
    enableNodeRotation: false,
    fpsCap: 60,
    enableFreeRotation: false,
  },

  cognitiveMesh: {
    semanticZoom: true,
    degreeSizing: true,
    myelination: true,
    synapticPruning: false,
    blastRadius: true,
    dataFlowParticles: true,
    cycleDetection: false,
    neuralNebula: true,
    clusterRotation: false,
    agentOrbit: false,
    agenticPanels: true,
    timeTravelOpen: false,
    sonification: false,
    ambientHeartbeat: false,
    foveatedLOD: true,
    bloomIntensity: 1.0,
    pruneThreshold: 0.2,
    particleDensity: 1.0,
    timeScrubIndex: 0,
    timeCompression: 4,
  },

  setAuditHubOpen: (isOpen) => set({ isAuditHubOpen: isOpen }),
  toggleAuditHub: () => set({ isAuditHubOpen: !get().isAuditHubOpen }),
  setWikiHubOpen: (isOpen) => set({ isWikiHubOpen: isOpen }),
  setActiveWikiConcept: (concept) => set({ activeWikiConcept: concept }),
  setUIVersion: (version) => set({ uiVersion: version }),
  toggleUIVersion: () => set({ uiVersion: get().uiVersion === 'v1' ? 'v2' : 'v1' }),
  setPlaybackIndex: (index) => set({ playbackIndex: index }),
  setViewMode: (mode) => set({ viewMode: mode }),
  setCodeGraph: (graph) => set({ codeGraph: graph }),
  setIsCodeGraphScanOpen: (isOpen) => set({ isCodeGraphScanOpen: isOpen }),
  setIsGraphManagerOpen: (isOpen) => set({ isGraphManagerOpen: isOpen }),

  setSelectionTier: (tier) => set({ selectionTier: tier }),
  setSynthesisMode: (mode) => set({ synthesisMode: mode }),
  setSyncMode: (mode) => set({ syncMode: mode }),
  setVisibleTypes: (types) => set({ visibleTypes: types }),
  setVisibleEdgeTypes: (types) => set({ visibleEdgeTypes: types }),
  toggleShowClusters: () => set({ showClusters: !get().showClusters }),
  setStarCount: (count) => set({ graphRenderSettings: { ...get().graphRenderSettings, starCount: count } }),
  setEnableNodeRotation: (enabled) => set({ graphRenderSettings: { ...get().graphRenderSettings, enableNodeRotation: enabled } }),
  setFpsCap: (fps) => set({ graphRenderSettings: { ...get().graphRenderSettings, fpsCap: fps } }),
  setEnableFreeRotation: (enabled) => set({ graphRenderSettings: { ...get().graphRenderSettings, enableFreeRotation: enabled } }),

  toggleCognitiveMesh: (key) => set({
    cognitiveMesh: { ...get().cognitiveMesh, [key]: !get().cognitiveMesh[key] }
  }),
  setCognitiveMeshValue: (key, value) => set({
    cognitiveMesh: { ...get().cognitiveMesh, [key]: value }
  }),
});

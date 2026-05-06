console.log("BOOT: useKg3dStore.ts (Restored)");
import { create } from 'zustand';
import { calculateFocusPath } from '../components/Studio/kg3d/focusPath';

// KG3D-001 Types (Inlined to bypass resolution issues)
export type NodeCategory = 'approximations_expansions' | 'ai_deep_learning' | 'calc_variations_control' | 'combinatorics_number_theory' | 'computer_vision_pattern_recognition' | 'functional_analysis_real_functions' | 'information_communication_theory' | 'llm_nlp' | 'linear_multilinear_algebra_matrix_theory' | 'measure_integration' | 'neural_evolutionary_computing' | 'numerical_analysis_signal_processing' | 'ops_research_math_programming' | 'optimisation_reinforcement_learning' | 'ode_pde' | 'probability_stochastic_statistics';

export type EdgeKind = 'prerequisite' | 'references' | 'contradicts' | 'generalises' | 'specialises';

export interface NodeMetrics {
  pagerank: number;
  degree: number;
  betweenness: number;
  descendant_ratio: number;
  prerequisite_ratio: number;
  reachability_ratio: number;
}

export interface KgNode {
  id: string;
  canonical_name: string;
  display_name: string;
  category: NodeCategory;
  aot_layer: number;
  metrics: NodeMetrics;
  position_hint?: { x: number, y: number, z: number } | null;
  source_refs?: string[];
}

export interface KgEdge {
  id: string;
  source_id: string;
  target_id: string;
  kind: EdgeKind;
  weight: number;
}

export interface DeltaEvent {
  kind: 'upsert_node' | 'upsert_edge' | 'remove_node' | 'remove_edge' | 'metrics_refresh' | 'heartbeat';
  payload?: { [key: string]: any } | null;
  seq: number;
}

interface Kg3dState {
  nodes: KgNode[];
  edges: KgEdge[];
  selectedConceptId: string | null;
  focusIds: Set<string>;
  
  // Actions
  setGraph: (nodes: KgNode[], edges: KgEdge[]) => void;
  selectConcept: (id: string | null) => void;
  syncWithSymbol: (symbolName: string) => void;
}

export const useKg3dStore = create<Kg3dState>((set, get) => ({
  nodes: [],
  edges: [],
  selectedConceptId: null,
  focusIds: new Set(),

  setGraph: (nodes, edges) => set({ nodes, edges }),

  selectConcept: (id) => {
    const { nodes, edges } = get();
    const focusIds = calculateFocusPath(nodes, edges, id, 2);
    set({ selectedConceptId: id, focusIds });
  },

  syncWithSymbol: (symbolName) => {
    const { nodes } = get();
    // Case-insensitive fuzzy match for symbols (KG3D-F7)
    const match = nodes.find(n => 
      n.canonical_name.toLowerCase() === symbolName.toLowerCase() ||
      n.display_name.toLowerCase().includes(symbolName.toLowerCase())
    );
    if (match) {
      get().selectConcept(match.id);
    }
  }
}));

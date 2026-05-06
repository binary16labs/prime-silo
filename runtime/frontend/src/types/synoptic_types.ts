/**
 * KG3D Synoptic Types - migrated to bypass Vite cache corruption.
 */
export const SYNOPTIC_TYPES_VERSION = '1.0.1';

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

export interface PositionHint {
  x: number;
  y: number;
  z: number;
}

export interface Node {
  id: string;
  canonical_name: string;
  display_name: string;
  category: NodeCategory;
  aot_layer: number;
  metrics: NodeMetrics;
  position_hint?: PositionHint | null;
  source_refs?: string[];
  created_at?: string;
  updated_at?: string;
}

export interface Edge {
  id: string;
  source_id: string;
  target_id: string;
  kind: EdgeKind;
  weight: number;
  evidence?: string[];
  created_at?: string;
}

// Prefix aliases for safety
export type KgNode = Node;
export type KgEdge = Edge;

export interface Proposal {
  nodes_upsert: Node[];
  edges_upsert: Edge[];
  rationale_md: string;
}

export interface DeltaEvent {
  kind: 'upsert_node' | 'upsert_edge' | 'remove_node' | 'remove_edge' | 'metrics_refresh' | 'heartbeat';
  payload?: { [key: string]: any } | null;
  seq: number;
  ts?: string;
}

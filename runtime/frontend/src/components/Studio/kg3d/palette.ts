/**
 * Synoptic Web Cyber-Diagnostic Palette
 * Per KG3D-001 requirements
 */
export const CATEGORY_COLORS: Record<string, string> = {
  approximations_expansions: "#4dabf7", // Blue
  ai_deep_learning: "#f03e3e",          // Cyber Red
  calc_variations_control: "#37b24d",    // Green
  combinatorics_number_theory: "#f76707", // Orange
  computer_vision_pattern_recognition: "#7048e8", // Deep Purple
  functional_analysis_real_functions: "#ae3ec9", // Violet
  information_communication_theory: "#1098ad", // Cyan
  llm_nlp: "#f59f00",                   // Gold/Amber
  linear_multilinear_algebra_matrix_theory: "#c2255c", // Pink
  measure_integration: "#1c7ed6",       // Azure
  neural_evolutionary_computing: "#2b8a3e", // Forest
  numerical_analysis_signal_processing: "#0b7285", // Teal
  ops_research_math_programming: "#e8590c", // Dark Orange
  optimisation_reinforcement_learning: "#39FF14", // Neon Green
  ode_pde: "#1864ab",                   // Deep Blue
  probability_stochastic_statistics: "#d9480f", // Vermillion
  default: "#adb5bd"
};

export const EDGE_COLORS: Record<string, string> = {
  prerequisite: "#ffffff",
  references: "rgba(255, 255, 255, 0.2)",
  contradicts: "#ff0000",
  generalises: "#00ffff",
  specialises: "#ff00ff"
};

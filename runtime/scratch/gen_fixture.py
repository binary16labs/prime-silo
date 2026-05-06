import json
import hashlib
from datetime import datetime

categories = [
    "approximations_expansions", "ai_deep_learning", "calc_variations_control",
    "combinatorics_number_theory", "computer_vision_pattern_recognition",
    "functional_analysis_real_functions", "information_communication_theory",
    "llm_nlp", "linear_multilinear_algebra_matrix_theory",
    "measure_integration", "neural_evolutionary_computing",
    "numerical_analysis_signal_processing", "ops_research_math_programming",
    "optimisation_reinforcement_learning", "ode_pde",
    "probability_stochastic_statistics"
]

def get_id(name):
    return hashlib.sha256(name.lower().encode()).hexdigest()[:16]

nodes = []
# Create ~3 nodes per category to reach ~50
concepts = {
    "approximations_expansions": ["Taylor Series", "Fourier Transform", "Wavelets"],
    "ai_deep_learning": ["Neural Network", "Backpropagation", "Convolutional Layer", "Transformer"],
    "calc_variations_control": ["Euler-Lagrange Equation", "Pontryagin Minimum Principle", "PID Control"],
    "combinatorics_number_theory": ["Binomial Coefficient", "Prime Number Theorem", "Graph Coloring"],
    "computer_vision_pattern_recognition": ["Edge Detection", "SIFT", "Image Segmentation"],
    "functional_analysis_real_functions": ["Hilbert Space", "Banach Space", "Lp Space"],
    "information_communication_theory": ["Shannon Entropy", "Channel Capacity", "Huffman Coding"],
    "llm_nlp": ["Attention Mechanism", "Word2Vec", "BERT", "GPT-4"],
    "linear_multilinear_algebra_matrix_theory": ["Eigenvalue", "SVD", "Determinant"],
    "measure_integration": ["Lebesgue Measure", "Borel Set", "Measure Space"],
    "neural_evolutionary_computing": ["Genetic Algorithm", "Neuroevolution", "Particle Swarm Optimization"],
    "numerical_analysis_signal_processing": ["Newton's Method", "Runge-Kutta", "Discrete Fourier Transform"],
    "ops_research_math_programming": ["Linear Programming", "Simplex Algorithm", "Integer Programming"],
    "optimisation_reinforcement_learning": ["Gradient Descent", "Q-Learning", "Policy Gradient", "Adam Optimizer"],
    "ode_pde": ["Heat Equation", "Wave Equation", "Navier-Stokes"],
    "probability_stochastic_statistics": ["Bayes Theorem", "Gaussian Distribution", "Markov Chain", "Central Limit Theorem"]
}

node_list = []
for cat, names in concepts.items():
    for name in names:
        node_id = get_id(name)
        # Randomish descendant ratio for aot_layer distribution
        # 1: >0.8, 2: 0.5-0.8, 3: 0.25-0.5, 4: 0.1-0.25, 5: <0.1
        if "Equation" in name or "Space" in name or "Theorem" in name:
            dr = 0.85 # layer 1
        elif "Algorithm" in name or "Method" in name:
            dr = 0.6 # layer 2
        elif "Layer" in name or "Feature" in name:
            dr = 0.15 # layer 4
        else:
            dr = 0.35 # layer 3
        
        node_list.append({
            "id": node_id,
            "canonical_name": name,
            "display_name": name,
            "category": cat,
            "aot_layer": 1 if dr >= 0.8 else (2 if dr >= 0.5 else (3 if dr >= 0.25 else (4 if dr >= 0.1 else 5))),
            "metrics": {
                "pagerank": 0.01,
                "degree": 0,
                "betweenness": 0.0,
                "descendant_ratio": dr,
                "prerequisite_ratio": 0.2,
                "reachability_ratio": 0.5
            },
            "position_hint": None,
            "source_refs": [],
            "created_at": "2026-04-19T18:00:00Z",
            "updated_at": "2026-04-19T18:00:00Z"
        })

# Create edges
edges = []
# Prerequisite links (DAG)
# e.g. Linear Algebra -> SVD
edges.append({
    "id": "e1", "source_id": get_id("Eigenvalue"), "target_id": get_id("SVD"),
    "kind": "prerequisite", "weight": 1.0, "evidence": ["Linear Algebra Fundamentals"], "created_at": "2026-04-19T18:00:00Z"
})
edges.append({
    "id": "e2", "source_id": get_id("Gradient Descent"), "target_id": get_id("Backpropagation"),
    "kind": "prerequisite", "weight": 1.0, "evidence": ["Chain Rule"], "created_at": "2026-04-19T18:00:00Z"
})
edges.append({
    "id": "e3", "source_id": get_id("Attention Mechanism"), "target_id": get_id("Transformer"),
    "kind": "prerequisite", "weight": 1.0, "evidence": ["Attention is all you need"], "created_at": "2026-04-19T18:00:00Z"
})
# ... add more to reach 100 or just enough for a healthy test graph
# For the mock, I'll just generate them systematically
all_ids = [n["id"] for n in node_list]
for i in range(len(all_ids) - 1):
    edges.append({
        "id": f"edge_{i}",
        "source_id": all_ids[i],
        "target_id": all_ids[i+1],
        "kind": "prerequisite",
        "weight": 0.5,
        "evidence": [],
        "created_at": "2026-04-19T18:00:00Z"
    })

fixture = {
    "nodes": node_list,
    "edges": edges
}

with open("C:/Users/nsdha/OneDrive/code/benny/tests/fixtures/kg3d/ml_knowledge_graph_v1.json", "w") as f:
    json.dump(fixture, f, indent=2)

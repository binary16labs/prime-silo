# Synthesis Knowledge Graph Engine: Architecture & Implementation

This document provides a technical overview of how Benny transforms raw documents into a structured, navigable, and synthetic knowledge graph.

## 1. High-Level Design Philosophy
The Benny Knowledge Graph (KG) moves beyond simple vector retrieval (RAG) by focusing on **Idea Synthesis**. Unlike a standard database, the KG represents knowledge as a network of **Concepts** and **Relationships**, allowing the system to:
-   **Discover Analogies**: Find similar patterns across different domains (e.g., how a neural network is like a biological fungal network).
-   **Detect Conflicts**: Identify contradictory information across different sources.
-   **Cluster Semantically**: Group ideas based on their underlying meaning, not just keyword matches.

---

## 2. System Architecture

The architecture consists of three logical layers, integrated through a FastAPI backend and a Neo4j database.

### A. Ingestion Layer (Docling + LLM)
1.  **Structured Parsing**: Benny uses **Docling** to parse files (PDF, MD, TXT). Unlike standard parsers, Docling preserves document structure (headers, tables, lists), which is critical for maintaining context during triple extraction.
2.  **Triple Extraction**: The system uses a "Logic Layer" in the LLM to extract knowledge in the format of `(Subject, Predicate, Object)`. 
    -   *Example*: `(Dopamine, drives, reward-seeking behavior)`.
3.  **Entity Resolution**: Concepts are "Merged" in Neo4j based on their name and workspace, ensuring that different documents referencing the same entity point to the same node.

### B. Conceptual Cluster Layer (Vector Grounding)
1.  **Dual-Model Embedding**: Every `Concept` node in the graph is assigned a vector embedding (using Ollama's `nomic-embed-text` or OpenAI).
2.  **Semantic Indices**: These embeddings are stored directly in Neo4j.
3.  **Venn Clustering**: Benny computes pairwise cosine similarities between concepts. If two concepts are mathematically similar (above a 0.75 threshold), they are considered "Semantically Linked," even if they share no direct edges in the graph.

### C. Synthesis Layer (Structural Isomorphism)
1.  **Pattern Recognition**: The system summarizes the local graph neighborhood and asks a "Synthesis LLM" to identify structural analogies.
2.  **Cross-Domain Mapping**: When a pattern is found (e.g., "Decentralized Resilience"), Benny creates an `ANALOGOUS_TO` relationship between concepts from different domains.

---

## 3. Implementation Details

### Data Schema (Neo4j)
-   **Nodes**:
    -   `:Concept {name, workspace, embedding, domain, created_at}`
    -   `:Source {name, workspace, path, size, created_at}`
-   **Relationships**:
    -   `-[:RELATES_TO {predicate, source_doc}]->`: The primary factual link.
    -   `-[:SOURCED_FROM]->`: Links a concept back to its originating document.
    -   `-[:ANALOGOUS_TO {pattern, description}]->`: A cross-domain analogy link.
    -   `-[:CONFLICTS_WITH {description}]->`: A link between contradictory concepts.

### Key Logic Modules
-   **[synthesis/engine.py](file:///c:/Users/nsdha/OneDrive/code/benny/benny/synthesis/engine.py)**: The brain of the operation. Contains the LLM prompts and logic for triple extraction, conflict detection, and analogy finding.
-   **[core/graph_db.py](file:///c:/Users/nsdha/OneDrive/code/benny/benny/core/graph_db.py)**: The integration layer. Handles all Cypher queries, vector searches within Neo4j, and graph schema initialization.
-   **[core/extraction.py](file:///c:/Users/nsdha/OneDrive/code/benny/benny/core/extraction.py)**: Utilizes Docling to prepare text for the synthesis engine.

---

## 4. Lifecycle of a Document to Graph Ingestion
1.  **User Trigger**: The user selects documents in the Study Notebook and clicks "Map Selected Documents."
2.  **Backend Processing**:
    -   `graph_routes.py` receives the list of files.
    -   For each file, `Docling` extracts structured text.
    -   The `SynthesisEngine` extracts triples via LLM.
    -   Triples are committed to Neo4j.
    -   The LLM checks for conflicts against existing nodes in that workspace.
3.  **Embedding Pulse**: The system generates embeddings for all new concept nodes.
4.  **Real-time Visualization**: The `KnowledgeGraphCanvas` (React) polls the graph status and renders the updated network in 3D using `3d-force-graph`.
5.  **Synthesis**: The user can manually trigger "Discover Structural Isomorphisms" to run the final analogy layer.

---

## 5. Technology Stack
| Component | Technology | Role |
| :--- | :--- | :--- |
| **Graph DB** | Neo4j | Relational and Vector storage |
| **Parsing** | Docling | High-fidelity structural extraction |
| **LLM Orchestration** | LiteLLM / Lemonade | Triple extraction and pattern synthesis |
| **UI Visualization** | 3d-force-graph | Interactive 3D graph exploration |
| **Communication** | FastAPI | Batch ingestion and synchronous graph queries |

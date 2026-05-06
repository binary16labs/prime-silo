Benny: Synthesis Knowledge Graph Engine
This document outlines the implementation plan to integrate the Synthesis Knowledge Engine (Morphic+) natively into the Benny ecosystem. It shifts the AI paradigm from simple "Answer" retrieval to true "Idea Synthesis," explicitly mapping relationships, semantic overlaps, and cross-domain analogies.

NOTE

Since this is for the Benny project, the architecture has been streamlined to leverage your existing stacks: FastAPI (Backend), React/Vite Studio (Frontend), and your local LLM infrastructure (Lemonade, Ollama, FastFlow) via LiteLLM.

Benny-Native Architecture
The system will be built as an extension to Benny's existing agentic workflows and toolsets.

1. Ingestion Layer (Docling & Hierarchical Parsing)
   Purpose: High-performance, structured document parsing with an L1/L2 agentic workflow.
   Processing: Docling parses documents into hierarchical sections (L1). The L2 sub-agent recursively extracts directed points explicitly guided by user-defined synthesis intents configured directly in the Synthesis UI.
   Hardware Resilience: Includes explicit Inference Delay handlers adjustable via the UI to prevent AMD/Intel NPU thermal throttling during batch document mapping.
   Model Support: Optimized for high-parameter local models (e.g., Gemma 4 26B, Llama 3.1) and smaller efficient models (Gemma 2 9B), leveraging GGUF/NPU acceleration via Lemonade or LM Studio. Row-level extraction handles complex JSON schemas for citation and confidence scores.
2. Logic & Processing Layers (The Benny Backend)
   The core logic is divided into three distinct processing mechanisms running via FastAPI:

A. The Relational Graph (The "Who & What")
Mechanism: Named Entity Recognition (NER) and Relation Extraction using Benny's connected LLM (e.g., Gemma 4 26B, Llama 3).
Output: Extracts knowledge 4-tuples (Subject, Predicate, Object, Citation) with explicit granular binding to their respective hierarchical `section` metadata.
Entity Typing: Nodes are semantically categorized (e.g., Theory, Technology, Person, Organization, Location, Event, Concept) to enable color-coded filtering.
Citation Tracking: Every relationship stores the exact verbatim "Citation" excerpt from the source text natively on the Neo4j edge.
Database: Neo4j 5 architecture (using modern `elementId` schemas). Provides robust native integration for vector search combined with complex graph traversal.
B. The Conceptual Cluster (The "Venn")
Mechanism: Semantic Vector Embeddings setup for Dual-Model Support.
Model: Explicit embedding string mapping (e.g., `nomic-embed-text-v1-GGUF`) integrates seamlessly into requests from the Benny Synthesis UI directly alongside generalized cloud structures (OpenAI text-embedding-3), unchaining embeddings from local backend assumptions.
Function: Calculates bounded similarity distances between ideas. Topics with overlapping vector space (even without shared keywords) are mathematically clustered.
C. The Synthesis Layer (The "So What?")
Mechanism: Advanced LangGraph node processing specifically prompted for Structural Isomorphisms.
Function: Identifies patterns that repeat across different fields (e.g., mapping biological virus spread to sociological meme spread) and records these synthesis loops back to the graph. 3. Notebook UI Integration (Benny Studio)
The Graph Knowledge Engine is natively embedded into the Benny React Frontend.

Split-View Workspace: The Benny Studio Notebook features a primary chat/reading area alongside a collapsible, interactive canvas for full-screen exploration.
3D Interactive Canvas: Powered by 3d-force-graph (WebGL), featuring:
- Click-to-Focus Isolation: Clicking a node dims the rest of the graph to 10% opacity, isolating the concept's neighborhood.
- Edge Tooltips: Hovering over relationships reveals the Citation excerpt, source section, and confidence score.
- Dynamic Search & Filtering: A canvas-level search bar allows live filtering of nodes and types.
- Visual Confidence: Edge thickness and opacity scale with the LLM's confidence score (0.0 - 1.0).
- Semantic Legend: Interactive legend to toggle visibility of specific entity types (e.g., show only 'Theories'). 4. Agent Accessibility (Benny Tools)
The generated Knowledge Graph becomes Benny's Structural Long-Term Memory.

Benny Tools: New Python agents in benny/tools/ will be created (e.g., query_network_graph, find_isomorphisms, add_triple_relation).
Graph State: Agents in Benny's LangGraph workflows can programmatically traverse the relational graph, pull context for their tasks, and write new synthesis connections back to the database.
Expanding Features
To truly differentiate from existing tools, the following advanced features will be implemented directly in the Benny Studio:

1. Temporal Tracking (Idea Evolution)
   Implementation: Storing temporal metadata on Neo4j nodes.
   UI Element: A "Time Slider" UI component in Benny Studio that filters graph edges based on publication date.
2. Conflict Detection
   Implementation: A verification node during ingestion that checks for contradictory triples. Built with strict payload bounding (`new_triples` context caps) and JSON-escaped prompt templates for robustness. Exception guards capture and print full tracebacks to the terminal during failures.
   UI Element: Highlighting conflicting nodes in red, allowing the user to inspect the source of the disagreement.
3. Relationship Weighting (Confidence Engine)
   Implementation: LLM-assigned "Confidence" scores stored as edge properties.
   UI Element: Visual differentiation (solid vs. dashed lines, varies by opacity) to indicate the reliability of a mapped relationship.
4. Cross-Domain Analogy Engine
   Implementation: A targeted prompt template that leverages the Synthesis Layer via LiteLLM.
   UI Element: Context-menu actions in the Notebook visualizer (e.g., right-click node -> "Show in context of... [Physics, Music Theory]").
   Development Phases
   Phase 1: Benny Infrastructure & DB
   Update Benny's docker-compose.yml to include the Neo4j standalone container alongside Marquez.
   Update FastAPI backend configurations to connect to the Neo4j endpoint.
   Build Docling-based hierarchical ingestion pipelines to extract structured Markdown and handle L1/L2 directed parsing based on user configuration.
   Phase 2: Dual-Embedding & Benny Graph Logic
   Integrate embedding model routing logic to support both local (Ollama) and cloud (OpenAI) endpoints via Benny's configuration payload.
   Implement the LLM triple extraction (Relational Graph) as a reusable Benny tool/node.
   Implement the "Venn" clustering similarity algorithm on the extracted embeddings.
   Phase 3: Benny Studio UI Integration
   Build the split-view layout in the React frontend.
   Integrate 3d-force-graph into the right-hand canvas.
   Wire up the frontend components to display the graph and handle real-time clustering via Websockets or FastAPI polling.
   Phase 4: Benny Agent Tools & Advanced AI
   Create benny/tools/ libraries allowing agents to query and write triples back to the structural long-term memory.
   Implement the Conflict Detection LangGraph node, Temporal Tracking, and Cross-Domain Analogy contextual actions.
   Verification Plan
   Automated Testing
   Unit tests (tests/test_graph_synthesis.py) for the triple extraction formatting using Benny's test suite.
   Agent Tool Tests: Verify that a Benny agent can successfully request get_neighbors(Node) via the new FastAPI endpoint using both local and cloud embeddings.
   Manual Verification
   Simulated Query Test: We will manually run the test case: "Connect Decentralized Finance (DeFi) and Mycelium Fungal Networks" through the Benny UI.
   Expected Output: The Benny Studio Notebook UI should render the Relational Graph (nodes/edges), Venn Overlap data, and the Structural Isomorphism ("Resilience through Redundancy").
   Verify that a Benny autonomous workflow successfully queries the graph and utilizes it to answer a complex synthesis question.

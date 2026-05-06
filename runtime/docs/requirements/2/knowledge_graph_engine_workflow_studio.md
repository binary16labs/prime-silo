Synthesis Engine Workflow in Studio
This plan outlines the steps to integrate the Synthesis Engine as a first-class workflow in the Benny Studio. This will allow users to visually coordinate document ingestion, triple extraction, and cross-domain synthesis.

User Review Required
IMPORTANT

This change introduces two new operations to the Data Node type in the Studio: graph_ingest and graph_synthesize.

graph_ingest now includes a mode parameter: append (default) or overwrite (clears previous source data before ingestion).
graph_synthesize triggers the discovery of structural isomorphisms across the graph.
CAUTION

Human-in-the-Loop (HITL) is implemented via a new breakpoint node. When the workflow hits this node, it will pause and require user approval via the Studio UI before proceeding to sensitive steps like final synthesis or report generation.

Proposed Changes
Backend: Studio Executor & Skills
[MODIFY]
studio_executor.py
Extend execute_data_node to handle graph_ingest and graph_synthesize operations.
graph_ingest: Supports mode='overwrite' to clear old triples for the specific file before re-ingesting.
NEW: Implement execute_breakpoint_node: Pauses execution and persists state to workspace/.benny/studio_executions.json.
NEW: Add /workflows/resume endpoint to sustain the HITL flow.
[MODIFY]
skill_registry.py
Add a new built-in skill synthesize_graph: Allows an agent to trigger the isomorphism detection (synthesis) layer on the current workspace graph.
Add a new built-in skill write_report: Specifically designed to take structured synthesis findings and format them into a high-fidelity markdown report in the reports directory.
Update SKILL_HANDLERS to include both new synthesis and reporting logic.
Synthesis Engine Process
The Synthesizer works in two phases:

Structural Detection: A deterministic algorithm (in engine.py) finds isomorphisms—patterns that repeat across different concepts (e.g., managing a dog's hierarchy vs. managing an AI's agentic hierarchy).
LLM Review: These raw patterns are passed to an Agent node. The LLM reviews the "So What?", filters out weak analogies, and expands on the truly transformative insights.
Templates: Synthesis Workflow
[NEW]
synthesis-engine-dog-analogy.json
Create a template workflow that:
Triggers manually.
Ingests FrolovRoutledge2024.pdf and The_Dog.md with the synthesis direction.
Breakpoint: Pauses for user review to validate the extracted graph triples.
Synthesizes findings.
Agent Review & Report: The LLM reviews the isomorphisms and uses the write_report skill to output the final governance support document.
Frontend: Node UI (Optional but recommended for visibility)
[MODIFY]
DataNode.tsx
Add labels for graph_ingest ("Graph Ingest") and graph_synthesize ("Graph Synthesize").
Open Questions
Should the graph_ingest node always re-ingest files, or should it check if they are already in the graph? (Current plan: re-ingest to ensure the "direction" prompt is applied).
Verification Plan
Automated Tests
Use test_api_chat.py (modified) to verify that a Studio workflow execution request with the new node types succeeds.
Manual Verification
Deploy the backend and load the Benny Studio.
Verify that the "Synthesis Engine" workflow appears in the workflow list.
Run the workflow and check the logs/Neo4j for the newly created triples and analogies.

"""Deterministic diagram-cleanup pass for the generated SAD.

The local 9B model emitted several diagrams with invalid syntax:
  * `usecaseDiagram` fenced as ```mermaid — Mermaid has NO use-case diagram
    type; these must be PlantUML.
  * one use-case block is actually a sequence diagram (participant + arrows).
  * the `erDiagram` uses non-grammar lines (`{||..||}`) and an unsupported
    `note` directive.
  * some `sequenceDiagram` participants are quoted (`as "Name"`).

This rewrites each broken block with valid, equivalent syntax (preserving the
real prime-silo components the model referenced) and inserts a C4-Component
diagram. It matches blocks by a unique signature line and replaces the whole
enclosing fence, so it is robust to surrounding prose. Output is written to a
`.cleaned.md` sibling so the original is preserved.
"""
import re
import sys
from pathlib import Path

SRC = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(
    "home/workspaces/default/data_out/TOGAF_Plus_SAD_prime_silo.md")

text = SRC.read_text(encoding="utf-8")

# --- corrected blocks (full fenced code, including ``` fences) ------------------

UC1 = """```plantuml
@startuml
left to right direction
actor "Operator / Architect" as Op
rectangle "Benny Studio Backend API (:8005)" {
  usecase "Create Manifest Draft" as UC1
  usecase "Approve Manifest (HITL)" as UC2
  usecase "Execute Swarm Tasks" as UC3
  usecase "View Audit Logs & Lineage" as UC4
}
rectangle "Neo4j Data Layer" {
  usecase "Query Code Graph (AST)" as UCA1
  usecase "Enrich Knowledge Graph" as UCA2
}
Op --> UC1
Op --> UC2
Op --> UC3
Op --> UC4
UC3 ..> UCA1 : <<include>>
UC3 ..> UCA2 : <<include>>
@enduml
```"""

UC2 = """```plantuml
@startuml
left to right direction
actor "External Agent (Claude via MCP)" as ExtAg
rectangle "Prime-Silo Nexus (MCP Server)" {
  usecase "Semantic Search" as UC10
  usecase "Get Graph Stats" as UC11
  usecase "Execute Cypher (read-only)" as UC12
  usecase "Offload Exec" as UC13
}
ExtAg --> UC10
ExtAg --> UC11
ExtAg --> UC12
ExtAg --> UC13
note bottom of ExtAg : Read-only within the deterministic zone
@enduml
```"""

# Block @316 is mislabeled — it is a sequence diagram.
SEQ_MISLABELED = """```mermaid
sequenceDiagram
    actor Operator
    participant UI as Studio UI (React)
    participant API as Backend API (FastAPI)
    participant Swarm as Swarm Executor (LangGraph)
    participant Neo4jDB as Neo4j Dual Graph
    Operator->>UI: 1. Init Project / Create Workspace
    UI->>API: 2. POST /manifest_routes/plan_from_requirement
    API->>Swarm: 3. Generate DAG (Planner Node)
    Swarm->>Neo4jDB: 4. Store Plan (ManifestTask, ManifestDraft)
    Operator-->>UI: 5. Review & Sign (AgentAmp Cockpit)
    UI->>API: 6. POST /manifest_routes/approve_manifest
    API->>Swarm: 7. Trigger Execution (Orchestrator Node)
    Swarm->>Neo4jDB: 8. Update Status (Draft -> Running)
    Note right of Operator: Operator initiates workflow and provides HITL approval
```"""

ERD = """```mermaid
erDiagram
    SwarmManifest ||--o{ ManifestTask : contains
    SwarmManifest ||--o{ RunRecord : executed_as
    RunRecord ||--o{ GovernanceEvent : logs_audit_ref
    SwarmManifest ||--o{ GovernanceEvent : generates_audit_log
    File ||--o{ Class : defines
    File ||--o{ Function : defines
    CodeEntity ||--o{ File : is_a
    Document ||--o{ Concept : yields
    Concept ||--o{ Source : sourced_from
    ManifestTask ||--o{ CodeEntity : analyzes_dependencies
    ManifestTask ||--o{ Concept : enriches_context
    Concept ||--o{ CodeEntity : correlates_with
```"""

UC4 = """```plantuml
@startuml
left to right direction
actor "Operator" as Op
actor "Claude Agent (MCP)" as CA
rectangle "Benny Studio" {
  usecase "Create Manifest Plan" as UC1
  usecase "Approve Manifest" as UC2
  usecase "Execute Swarm Tasks" as UC3
  usecase "Generate Code Artifacts" as UC4
  usecase "Human-in-the-Loop Review" as UC5
}
Op --> UC1
Op --> UC2
CA ..> UC3 : Executes deterministic tasks
CA ..> UC4 : Generates code/docs
UC3 ..> UC5 : <<include>>
@enduml
```"""

C4_COMPONENT = """

### 4.2.3 C4 Component Diagram — Backend API (FastAPI :8005)
Decomposition of the Backend API container into its principal components and their dependencies on the data tier.

```mermaid
C4Component
    title Component Diagram - Backend API (FastAPI :8005)
    Container_Boundary(api, "Backend API") {
        Component(routes, "Route Modules", "FastAPI routers", "manifest_routes, rag_routes, graph_routes, pypes_routes, offload_routes, governance_routes")
        Component(runner, "Manifest Runner", "benny/graph/manifest_runner.py", "plan_from_requirement / execute_manifest")
        Component(swarmc, "Swarm Executor", "benny/graph/swarm.py", "LangGraph: planner -> wave_scheduler -> orchestrator -> dispatcher -> executor -> aggregator")
        Component(router, "LLM Router", "benny/core/models.py + local_executor.py", "call_model; lemonade / ollama / lmstudio")
        Component(gov, "Governance Middleware", "benny/governance", "X-Benny-API-Key, audit events, SSE bus")
    }
    ContainerDb(neo4j, "Neo4j", "Dual graph", "Code + Knowledge graph")
    ContainerDb(sqlite, "SQLite", "run-store", "RunRecord, LangGraph checkpoints")
    Rel(routes, runner, "invokes")
    Rel(runner, swarmc, "executes plan")
    Rel(swarmc, router, "calls models")
    Rel(swarmc, neo4j, "reads / writes graph")
    Rel(runner, sqlite, "persists runs")
    Rel(routes, gov, "wrapped by")
```
"""


def replace_fence(text, signature, replacement):
    """Replace the ```...``` fence that contains `signature` with `replacement`."""
    idx = text.find(signature)
    if idx == -1:
        print(f"  WARN: signature not found: {signature[:40]!r}")
        return text
    start = text.rfind("```", 0, idx)
    end = text.find("```", idx)  # closing fence: first ``` at/after the signature
    if start == -1 or end == -1:
        print(f"  WARN: fence bounds not found for {signature[:40]!r}")
        return text
    return text[:start] + replacement + text[end + 3:]


# Order matters: each signature is unique to one block.
text = replace_fence(text, 'usecase "Create Manifest Draft" as UC1', UC1)
text = replace_fence(text, "usecodeGraphStats", UC2)
text = replace_fence(text, "Init Project | UI : Create Workspace", SEQ_MISLABELED)
text = replace_fence(text, "CodeEntity {||..||} File", ERD)
text = replace_fence(text, 'include("Human-in-the-Loop Review")', UC4)

# Strip quoted participant names in any remaining mermaid sequence diagrams.
text = re.sub(r'(participant \w+ as )"([^"]+)"', r"\1\2", text)
# Strip quoted actor in a sequence (e.g. `participant Operator as "Operator"`).
text = re.sub(r'(actor \w+ as )"([^"]+)"', r"\1\2", text)

# Insert the C4 Component diagram right after the C4Container fence.
ctr = text.find("C4Container")
if ctr != -1:
    close = text.find("```", text.find("```", ctr) + 3)
    if close != -1:
        insert_at = close + 3
        text = text[:insert_at] + C4_COMPONENT + text[insert_at:]
        print("  inserted C4 Component diagram")

out = SRC.with_suffix(".cleaned.md")
out.write_text(text, encoding="utf-8")
print(f"wrote {out}")

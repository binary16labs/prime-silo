"""Pass 2 — make EVERY diagram render by converting to conservative Mermaid.

Root cause of the render failures (confirmed by inspecting the blocks):
  * Mermaid C4 diagrams (C4Context/C4Container/C4Component) are experimental and
    are NOT supported by most viewers (GitHub, VS Code previewers, etc.).
  * the model's flowchart had duplicate node IDs and `->`/`(...)` inside labels.
  * the robustness `graph` had `(Claude)` parentheses inside a `[...]` label
    (Mermaid reads `(` as a shape token → parse error).
  * the PlantUML class/use-case blocks need a second engine and had invalid
    member syntax.

Fix: rewrite all of these as plain Mermaid `flowchart` / `graph` / `classDiagram`
(the universally-supported subset — the same engine that already renders the
`sequenceDiagram` blocks). No experimental C4, no PlantUML, no parens-in-labels,
all node IDs unique. Input: the pass-1 `.cleaned.md`; output: `.final.md`.
"""
import sys
from pathlib import Path

SRC = Path(sys.argv[1])
text = SRC.read_text(encoding="utf-8")

CTX = """```mermaid
flowchart TB
    operator["Operator / Architect<br/>plans and approves manifests"]
    claude["Claude Agent via MCP<br/>read-only search and drafting"]
    subgraph benny["Benny Studio - BENNY_HOME"]
        api["Backend API<br/>FastAPI :8005"]
        ui["Studio UI<br/>React / Three.js :3000"]
        swarm["Swarm Executor<br/>LangGraph state machine"]
    end
    neo4j[("Neo4j Dual Graph<br/>:7687 Bolt / :7474 HTTP")]
    sqlite[("SQLite Run-Store<br/>RunRecord + checkpoints")]
    lemon["Lemonade :13305<br/>local LLM provider"]
    operator --> ui --> api
    operator -->|X-Benny-API-Key| api
    claude -->|read-only MCP| neo4j
    api --> swarm
    swarm --> neo4j
    swarm --> sqlite
    swarm -->|call_model| lemon
```"""

CONTAINER = """```mermaid
flowchart TB
    subgraph benny["Benny Studio"]
        api["Backend API<br/>FastAPI / uvicorn :8005"]
        ui["Studio UI<br/>React 19 / Vite / Three.js :3000"]
        swarm["Swarm Executor<br/>LangGraph state machine"]
        pypes["Pypes Engine<br/>bronze to silver to gold, CLP lineage"]
        amp["AgentAmp Cockpit<br/>aamp skin packs + HMAC"]
    end
    subgraph data["Data Layer - Neo4j :7474 / :7687"]
        code[("Code Graph<br/>File / Class / Function")]
        kg[("Knowledge Graph<br/>Concept / Document")]
    end
    sqlite[("SQLite Run-Store")]
    ui --> api
    api --> swarm
    swarm --> code
    swarm --> sqlite
    pypes --> kg
    amp --> api
```"""

COMPONENT = """```mermaid
flowchart TB
    subgraph api["Backend API - FastAPI :8005"]
        routes["Route Modules<br/>manifest_routes, rag_routes, graph_routes, pypes_routes, offload_routes"]
        runner["Manifest Runner<br/>benny/graph/manifest_runner.py"]
        swarmc["Swarm Executor<br/>benny/graph/swarm.py"]
        router["LLM Router<br/>benny/core/models.py + local_executor.py"]
        gov["Governance Middleware<br/>X-Benny-API-Key, SSE bus"]
    end
    neo4j[("Neo4j<br/>dual graph")]
    sqlite[("SQLite<br/>run-store")]
    routes --> runner --> swarmc
    swarmc --> router
    swarmc --> neo4j
    runner --> sqlite
    routes --> gov
```"""

BPMN = """```mermaid
flowchart TD
    subgraph actor["Actor / Operator"]
        A1[Define Requirement] -->|create draft| A2[Review and Approve]
        A2 -->|rejected| A1
    end
    subgraph planner["Planner Services - benny/graph/swarm.py"]
        B1[Generate DAG Plan] --> C1{Plan Valid?}
        C1 -->|no| A2
        C1 -->|yes| D1[Schedule Waves]
    end
    subgraph orch["Orchestrator - LangGraph"]
        D2[Assign Roles planner to architect to dev] --> E1[Context Handover via Neo4j]
        E1 --> F1{HITL Gate?}
        F1 -->|yes| G1[Pause and Notify Operator]
        F1 -->|no| H1[Execute Task Node]
    end
    subgraph exec["Executor - benny/core/local_executor.py"]
        H2[Invoke LLM Provider] --> I1[Generate Code or Analysis]
        I1 --> J1[Pypes Checkpoint]
        J1 --> K1{Task Complete?}
    end
    subgraph govl["Governance and Audit"]
        L1[Emit GovernanceEvent] --> M1[Audit Lineage]
    end
    A2 -->|approved| B1
    D1 --> D2
    G1 -->|resume| H1
    H1 --> H2
    K1 -->|yes| L1
    K1 -->|no| H2
```"""

ROBUST = """```mermaid
graph LR
    subgraph swarm["Swarm Executor - Risk Routing"]
        A[Planner] -->|generates task| B[Orchestrator]
        B -->|routes task| C{Risk Router}
        C -->|green| D[Internal LLM Provider]
        D --> E[Success / Checkpoint]
        C -->|yellow| F[MCP Server - Claude]
        F -.->|timeout or error| G[Fallback to Internal]
        C -->|red| H[Governance Middleware]
        H --> I[Human-in-the-Loop Halt]
    end
    style C fill:#f9f,stroke:#333,stroke-width:2px,color:black
```"""

# Use-case diagrams as Mermaid flowcharts (actor --> stadium-shaped use cases).
UC1 = """```mermaid
flowchart LR
    Op([Operator / Architect])
    subgraph api["Benny Studio Backend API :8005"]
        UC1([Create Manifest Draft])
        UC2([Approve Manifest - HITL])
        UC3([Execute Swarm Tasks])
        UC4([View Audit Logs and Lineage])
    end
    subgraph data["Neo4j Data Layer"]
        UCA1([Query Code Graph - AST])
        UCA2([Enrich Knowledge Graph])
    end
    Op --> UC1
    Op --> UC2
    Op --> UC3
    Op --> UC4
    UC3 -.->|include| UCA1
    UC3 -.->|include| UCA2
```"""

UC2 = """```mermaid
flowchart LR
    ExtAg([External Agent - Claude via MCP])
    subgraph nexus["Prime-Silo Nexus - MCP Server"]
        UC10([Semantic Search])
        UC11([Get Graph Stats])
        UC12([Execute Cypher - read only])
        UC13([Offload Exec])
    end
    ExtAg --> UC10
    ExtAg --> UC11
    ExtAg --> UC12
    ExtAg --> UC13
```"""

UC4 = """```mermaid
flowchart LR
    Op([Operator])
    CA([Claude Agent - MCP])
    subgraph studio["Benny Studio"]
        UC1([Create Manifest Plan])
        UC2([Approve Manifest])
        UC3([Execute Swarm Tasks])
        UC4([Generate Code Artifacts])
        UC5([Human-in-the-Loop Review])
    end
    Op --> UC1
    Op --> UC2
    CA -.->|executes| UC3
    CA -.->|generates| UC4
    UC3 -.->|include| UC5
```"""

CLASS = """```mermaid
classDiagram
    class SwarmManifest {
        +UUID manifest_id
        +Status status
        +List~ManifestTask~ tasks
        +List~Wave~ waves
        -HMACKeyRef signing_key
        +plan_from_requirement(req_text) SwarmManifest
        +sign() void
    }
    class ManifestTask {
        +UUID task_id
        +String role_name
        +List~ArtifactRef~ input_artifacts
        -ArtifactSchema output_schema
        +execute(context, provider) TaskResult
    }
    class WaveScheduler {
        +List~Wave~ waves
        +schedule(tasks) List~Wave~
        +next_wave() Wave
    }
    class RunRecord {
        +UUID run_id
        +Status status
        +List~GovernanceEvent~ events
    }
    SwarmManifest "1" *-- "many" ManifestTask : contains
    SwarmManifest "1" o-- "1" WaveScheduler : scheduled_by
    SwarmManifest "1" --> "many" RunRecord : executed_as
    ManifestTask ..> RunRecord : produces
```"""


def replace_fence(text, signature, replacement, label=""):
    idx = text.find(signature)
    if idx == -1:
        print(f"  WARN: not found: {label or signature[:40]!r}")
        return text
    start = text.rfind("```", 0, idx)
    end = text.find("```", idx)
    if start == -1 or end == -1:
        print(f"  WARN: bounds: {label or signature[:40]!r}")
        return text
    print(f"  replaced: {label}")
    return text[:start] + replacement + text[end + 3:]


# C4 -> flowchart (match each by its unique title line)
text = replace_fence(text, "Prime-Silo System Architecture Context View", CTX, "C4Context #1")
text = replace_fence(text, "System Context Diagram for Prime-Silo Application", CTX, "C4Context #2")
text = replace_fence(text, "Prime-Silo System Context Diagram", CTX, "C4Context #3")
text = replace_fence(text, "Container Diagram for Prime-Silo Application", CONTAINER, "C4Container")
text = replace_fence(text, "Component Diagram - Backend API", COMPONENT, "C4Component")
# Broken flowchart / graph
text = replace_fence(text, "Swimlanes defined by subgraphs", BPMN, "BPMN flowchart")
text = replace_fence(text, "Yellow Path: External/MCP", ROBUST, "Robustness graph")
# PlantUML -> Mermaid
text = replace_fence(text, 'usecase "Create Manifest Draft" as UC1', UC1, "use-case #1")
text = replace_fence(text, 'usecase "Semantic Search" as UC10', UC2, "use-case #2")
text = replace_fence(text, 'usecase "Generate Code Artifacts" as UC4', UC4, "use-case #3")
text = replace_fence(text, "class SwarmManifest {", CLASS, "class diagram")

# Sanity: no experimental/second-engine blocks should remain.
for bad in ("C4Context", "C4Container", "C4Component", "```plantuml", "@startuml"):
    n = text.count(bad)
    print(f"  remaining {bad!r}: {n}")

out = SRC.parent / "TOGAF_Plus_SAD_prime_silo.final.md"
out.write_text(text, encoding="utf-8")
print(f"wrote {out}")

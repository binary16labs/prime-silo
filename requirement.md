# Benny: Deterministic Graph Workflow Platform

**Production-Ready Multi-Model AI Orchestration with Built-in Governance**

---

## 1. Executive Summary

Benny is an enterprise-grade platform for building deterministic graph workflows that connect to cloud or local LLMs, manage data pipelines, and ensure full governance and auditability.

### Core Value Proposition

| Challenge            | Benny Solution                                         |
| -------------------- | ------------------------------------------------------ |
| Model Fragmentation  | Multi-model orchestration via LiteLLM (100+ providers) |
| Governance Gap       | Native OpenLineage + Phoenix distributed tracing       |
| Production Readiness | Workspace isolation, pass-by-reference, checkpointing  |
| Debug Complexity     | Full trace propagation with nested span hierarchy      |

---

## 2. Architecture Overview

### System Context (C4 Level 1)

```mermaid
graph TB
    User[User/UI] --> Benny[Benny Platform]
    Benny --> CloudLLM[Cloud LLMs<br/>OpenAI, Anthropic, etc.]
    Benny --> LocalLLM[Local LLMs<br/>Ollama, vLLM]
    Benny --> Storage[(File System/<br/>ChromaDB)]
    Benny --> Marquez[Marquez<br/>Lineage Backend]
    Benny --> Phoenix[Phoenix<br/>Tracing Backend]
```

### Container Architecture (C4 Level 2)

```
┌─────────────────────────────────────────────────────────────┐
│                        Benny Platform                        │
├─────────────┬─────────────┬─────────────┬───────────────────┤
│   UI Layer  │  API Layer  │  Runtime    │    Storage        │
│   (React)   │  (FastAPI)  │  (LangGraph)│  (ChromaDB/FS)    │
└─────────────┴─────────────┴─────────────┴───────────────────┘
```

---

## 3. Phase 1: Architectural Foundation

### 3.1 State Design

Define strict schemas using TypedDict or Pydantic for all data flowing through the system.

```python
from typing import TypedDict, Annotated, List
from langgraph.graph.message import add_messages

class GraphState(TypedDict):
    """Core state schema for all workflows"""
    messages: Annotated[List[BaseMessage], add_messages]
    context: dict                    # Data references, workspace info
    artifacts: List[str]             # Generated file paths
    errors: List[str]                # Error accumulator
    workspace_id: str                # Active workspace for isolation
    trace_context: dict              # W3C traceparent propagation
```

**Best Practices:**

- Use `add_messages` reducer for conversation history
- Include `workspace_id` for multi-tenant isolation
- Pass `trace_context` through for distributed tracing

### 3.2 Multi-Model Orchestration (LiteLLM)

> [!IMPORTANT]
> This is a key differentiator. Support 100+ LLM providers through unified interface.

#### Preconfigured Local LLM Providers

Benny supports three local LLM providers out of the box for easy testing and privacy:

| Provider       | Port  | API Style         | Use Case                                   |
| -------------- | ----- | ----------------- | ------------------------------------------ |
| **Lemonade**   | 13305  | OpenAI-compatible | AMD NPU acceleration, fastest local option |
| **Ollama**     | 11434 | OpenAI-compatible | Popular, wide model support                |
| **FastFlowLM** | 52625 | OpenAI-compatible | Intel NPU acceleration                     |

```python
from litellm import completion
import os

# =============================================================================
# PRECONFIGURED LOCAL LLM PROVIDERS
# =============================================================================

LOCAL_PROVIDERS = {
    "lemonade": {
        "name": "Lemonade",
        "port": 13305,
        "base_url": "http://localhost:13305/api/v1",
        "api_key": "not-needed",  # Local server, no key required
        "description": "AMD NPU accelerated inference",
        "startup_cmd": "LemonadeServer.exe serve --port 13305"
    },
    "ollama": {
        "name": "Ollama",
        "port": 11434,
        "base_url": "http://localhost:11434/v1",
        "api_key": "ollama",  # Dummy key for API compatibility
        "description": "Popular local LLM server",
        "startup_cmd": "ollama serve"
    },
    "fastflowlm": {
        "name": "FastFlowLM",
        "port": 52625,
        "base_url": "http://localhost:52625/v1",
        "api_key": "not-needed",
        "description": "Intel NPU accelerated inference",
        "startup_cmd": None  # Manual start required
    }
}

def configure_local_provider(provider: str = "lemonade", port: int = None):
    """Configure environment for local LLM provider"""
    config = LOCAL_PROVIDERS.get(provider, LOCAL_PROVIDERS["lemonade"])
    actual_port = port or config["port"]

    base_url = config["base_url"].replace(str(config["port"]), str(actual_port))
    os.environ["OPENAI_API_BASE"] = base_url
    os.environ["OPENAI_API_KEY"] = config["api_key"]

    return {
        "provider": provider,
        "port": actual_port,
        "base_url": base_url
    }

# =============================================================================
# MODEL REGISTRY (Cloud + Local)
# =============================================================================

MODEL_REGISTRY = {
    # Cloud models for high-quality reasoning
    "reasoning": {
        "model": "gpt-4-turbo",
        "provider": "openai",
        "cost_per_1k": 0.01,
        "use_for": ["planning", "complex_analysis"]
    },
    "writing": {
        "model": "claude-3-sonnet",
        "provider": "anthropic",
        "cost_per_1k": 0.003,
        "use_for": ["content_generation", "summarization"]
    },
    # Local models for privacy and cost savings
    "local_lemonade": {
        "model": "openai/Gemma-3-4b-it-FLM",
        "provider": "lemonade",
        "cost_per_1k": 0.0,
        "use_for": ["offline", "sensitive_data", "testing"]
    },
    "local_ollama": {
        "model": "ollama/llama3",
        "provider": "ollama",
        "cost_per_1k": 0.0,
        "use_for": ["offline", "sensitive_data"]
    },
    "local_fastflow": {
        "model": "deepseek-r1:8b",  # Tested: FastFlowLM with DeepSeek R1 8B
        "provider": "fastflowlm",
        "cost_per_1k": 0.0,
        "use_for": ["intel_npu", "offline", "testing", "reasoning"]
    }
}

def get_model_for_task(task_type: str) -> str:
    """Intelligent model routing based on task"""
    for profile in MODEL_REGISTRY.values():
        if task_type in profile["use_for"]:
            return profile["model"]
    return MODEL_REGISTRY["reasoning"]["model"]  # Default

# Usage with fallback
model = ChatLiteLLM(
    model=get_model_for_task("planning"),
    temperature=0,
    fallbacks=["gpt-3.5-turbo", "ollama/llama3"]
).bind_tools(tools)
```

**Cost Optimization Strategy:**

- Route simple tasks to cheaper models (40-60% savings)
- Use local models for privacy-sensitive data
- Fallback chains for reliability

### 3.3 LLM Management Console

> [!IMPORTANT]
> UI-based controls for managing local LLM services - start, stop, and monitor from the browser.

#### Management Console Architecture

```mermaid
graph LR
    UI[Management Console UI] --> API[FastAPI Backend]
    API --> CMD[Command Executor]
    CMD --> Ollama[Ollama Service]
    CMD --> Lemonade[Lemonade Service]
    CMD --> FastFlow[FastFlowLM Service]
    API --> Status[Status Monitor]
    Status --> UI
```

#### Console Features

| Feature                 | Description                                   |
| ----------------------- | --------------------------------------------- |
| **Service Status**      | Real-time health indicators for each provider |
| **Start/Stop Controls** | One-click buttons to manage services          |
| **Model Management**    | Pull, list, and delete models (Ollama)        |
| **Port Configuration**  | Configure custom ports per provider           |
| **Logs Viewer**         | Stream service logs in real-time              |

#### Backend API Endpoints

```python
from fastapi import APIRouter
import subprocess
import asyncio

router = APIRouter(prefix="/api/llm", tags=["LLM Management"])

# =============================================================================
# SERVICE COMMANDS
# =============================================================================

SERVICE_COMMANDS = {
    "ollama": {
        "start": "ollama serve",
        "stop": "taskkill /IM ollama.exe /F",  # Windows
        "check": "http://localhost:11434/v1/models"
    },
    "lemonade": {
        "start": "LemonadeServer.exe serve --port 13305",
        "stop": "taskkill /FI \"WINDOWTITLE eq lemonade*\" /F",
        "check": "http://localhost:13305/api/v1/models"
    },
    "fastflowlm": {
        "start": None,  # Manual start required
        "stop": None,
        "check": "http://localhost:52625/v1/models"
    }
}

@router.get("/status")
async def get_all_status():
    """Get status of all local LLM providers"""
    results = {}
    for provider, config in SERVICE_COMMANDS.items():
        results[provider] = await check_provider_status(config["check"])
    return results

@router.post("/{provider}/start")
async def start_provider(provider: str):
    """Start a local LLM provider service"""
    if provider not in SERVICE_COMMANDS:
        raise HTTPException(404, f"Unknown provider: {provider}")

    cmd = SERVICE_COMMANDS[provider]["start"]
    if not cmd:
        raise HTTPException(400, f"{provider} requires manual startup")

    # Start in background
    subprocess.Popen(cmd, shell=True, creationflags=subprocess.CREATE_NEW_CONSOLE)
    return {"status": "starting", "provider": provider}

@router.post("/{provider}/stop")
async def stop_provider(provider: str):
    """Stop a local LLM provider service"""
    if provider not in SERVICE_COMMANDS:
        raise HTTPException(404, f"Unknown provider: {provider}")

    cmd = SERVICE_COMMANDS[provider]["stop"]
    if not cmd:
        raise HTTPException(400, f"{provider} requires manual shutdown")

    subprocess.run(cmd, shell=True)
    return {"status": "stopped", "provider": provider}

# =============================================================================
# OLLAMA-SPECIFIC ENDPOINTS
# =============================================================================

@router.get("/ollama/models")
async def list_ollama_models():
    """List installed Ollama models"""
    resp = requests.get("http://localhost:11434/api/tags")
    return resp.json()

@router.post("/ollama/pull")
async def pull_ollama_model(model: str):
    """Pull a new model from Ollama registry"""
    resp = requests.post(
        "http://localhost:11434/api/pull",
        json={"name": model}
    )
    return {"status": "pulling", "model": model}

@router.delete("/ollama/models/{model}")
async def delete_ollama_model(model: str):
    """Delete an Ollama model"""
    resp = requests.delete(
        "http://localhost:11434/api/delete",
        json={"name": model}
    )
    return {"status": "deleted", "model": model}
```

#### React UI Component

```tsx
// LLMManager.tsx - Management Console Component

interface ProviderStatus {
  name: string;
  running: boolean;
  port: number;
  models?: string[];
}

const LLMManager: React.FC = () => {
  const [providers, setProviders] = useState<ProviderStatus[]>([]);
  const [loading, setLoading] = useState(false);

  // Fetch status on mount and every 10s
  useEffect(() => {
    fetchStatus();
    const interval = setInterval(fetchStatus, 10000);
    return () => clearInterval(interval);
  }, []);

  const fetchStatus = async () => {
    const resp = await fetch("/api/llm/status");
    const data = await resp.json();
    setProviders(
      Object.entries(data).map(([name, status]) => ({
        name,
        ...status,
      })),
    );
  };

  const startProvider = async (name: string) => {
    setLoading(true);
    await fetch(`/api/llm/${name}/start`, { method: "POST" });
    setTimeout(fetchStatus, 2000);
    setLoading(false);
  };

  const stopProvider = async (name: string) => {
    setLoading(true);
    await fetch(`/api/llm/${name}/stop`, { method: "POST" });
    setTimeout(fetchStatus, 1000);
    setLoading(false);
  };

  return (
    <div className="llm-manager">
      <h2>🤖 Local LLM Management</h2>

      <div className="provider-grid">
        {providers.map((p) => (
          <div key={p.name} className="provider-card">
            <div className="status-indicator">{p.running ? "✅" : "❌"}</div>
            <h3>{p.name}</h3>
            <p>Port: {p.port}</p>

            <div className="controls">
              <button
                onClick={() => startProvider(p.name)}
                disabled={p.running || loading}
              >
                ▶️ Start
              </button>
              <button
                onClick={() => stopProvider(p.name)}
                disabled={!p.running || loading}
              >
                ⏹️ Stop
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};
```

#### Windows Batch Commands (from dangpy)

```batch
@echo off
REM manage_llm.bat - LLM service management

if "%1"=="start-lemonade" (
    start "lemonade" cmd /k "LemonadeServer.exe serve --port 13305"
    echo Started Lemonade on port 13305
)

if "%1"=="start-ollama" (
    start "ollama" cmd /k "ollama serve"
    echo Started Ollama on port 11434
)

if "%1"=="stop-all" (
    taskkill /FI "WINDOWTITLE eq lemonade*" /F 2>nul
    taskkill /IM ollama.exe /F 2>nul
    echo All LLM services stopped
)

if "%1"=="status" (
    echo Checking LLM services...
    curl -s http://localhost:13305/api/v1/models >nul 2>&1 && echo Lemonade: RUNNING || echo Lemonade: STOPPED
    curl -s http://localhost:11434/v1/models >nul 2>&1 && echo Ollama: RUNNING || echo Ollama: STOPPED
    curl -s http://localhost:52625/v1/models >nul 2>&1 && echo FastFlowLM: RUNNING || echo FastFlowLM: STOPPED
)
```

### 3.4 Workspace Isolation

All operations scoped to active workspace for multi-tenant support.

```
workspace/
├── default/                    # Default workspace
│   ├── chromadb/              # Vector store
│   ├── data_in/               # Input files
│   ├── data_out/              # Generated artifacts
│   └── reports/               # Final outputs
├── project-alpha/             # Client project
│   ├── chromadb/
│   └── ...
└── project-beta/
    └── ...
```

**File Access Pattern:**

```python
def get_workspace_path(workspace_id: str, subdir: str = "") -> Path:
    """All file operations go through workspace-scoped paths"""
    base = Path(f"workspace/{workspace_id}")
    return base / subdir if subdir else base
```

---

## 4. Phase 2: Skills & Tool System

### 4.1 Skills Architecture

Skills are modular capabilities that agents can discover and use.

```
skills/
├── TOOLS.md                   # Master tool registry
├── knowledge_search/
│   └── SKILL.md              # Semantic search capability
├── file_operations/
│   └── SKILL.md              # Read/write files
├── data_processing/
│   └── SKILL.md              # CSV, PDF extraction
└── code_execution/
    └── SKILL.md              # Sandboxed Python REPL
```

**SKILL.md Format:**

```markdown
---
name: knowledge_search
description: Search workspace knowledge base using semantic similarity
---

## Usage

Use this skill to find relevant information from ingested documents.

## Tools

- `search_knowledge_workspace(query, workspace, top_k)` - Semantic search
- `read_full_document(document_name, workspace)` - Get complete document

## Examples

Action: search_knowledge_workspace
Action Input: {"query": "AGI safety risks", "workspace": "default", "top_k": 5}
```

### 4.2 Tool Implementation

```python
from langchain.tools import tool

@tool
def search_knowledge_workspace(
    query: str,
    workspace: str = "default",
    top_k: int = 5
) -> str:
    """
    Search the workspace knowledge base using semantic similarity.

    Args:
        query: Search query
        workspace: Workspace ID for scoped search
        top_k: Number of results to return

    Returns:
        Formatted search results with sources
    """
    chromadb_path = get_workspace_path(workspace, "chromadb")
    # ... implementation
    return formatted_results
```

### 4.3 Pass-by-Reference Pattern

> [!TIP]
> For data >5KB, store to file and pass reference URL. Reduces token costs 60-80%.

```python
PASS_BY_REFERENCE_THRESHOLD = 5 * 1024  # 5KB

def smart_output(content: str, filename: str, workspace: str) -> str:
    """Return content directly if small, otherwise save and return URL"""
    if len(content) < PASS_BY_REFERENCE_THRESHOLD:
        return content

    # Save to file and return reference
    path = get_workspace_path(workspace, f"data_out/{filename}")
    path.write_text(content)
    return f"📥 Content saved: http://localhost:8000/api/files/{workspace}/{filename}"
```

---

## 5. Phase 3: Graph Orchestration (LangGraph)

### 5.1 Graph Structure

```python
from langgraph.graph import StateGraph, END

def build_workflow() -> StateGraph:
    workflow = StateGraph(GraphState)

    # Define nodes
    workflow.add_node("planner", planner_agent)
    workflow.add_node("executor", executor_agent)
    workflow.add_node("tools", tool_executor)
    workflow.add_node("reviewer", review_agent)

    # Define edges with conditional routing
    workflow.add_edge("planner", "executor")
    workflow.add_conditional_edges(
        "executor",
        route_executor_output,
        {
            "tools": "tools",
            "review": "reviewer",
            "end": END
        }
    )
    workflow.add_edge("tools", "executor")
    workflow.add_edge("reviewer", END)

    workflow.set_entry_point("planner")
    return workflow

def route_executor_output(state: GraphState) -> str:
    """Conditional routing based on agent output"""
    last_message = state["messages"][-1]
    if hasattr(last_message, "tool_calls") and last_message.tool_calls:
        return "tools"
    if state.get("needs_review"):
        return "review"
    return "end"
```

### 5.2 Human-in-the-Loop (Governance Checkpoint)

```python
from langgraph.checkpoint import interrupt

def sensitive_operation_node(state: GraphState) -> GraphState:
    """Node that requires human approval before execution"""
    action = state["pending_action"]

    # Interrupt for human approval
    approved = interrupt({
        "action": action,
        "description": "This action requires approval",
        "impact": "Will modify database records"
    })

    if approved:
        execute_action(action)
        return {**state, "status": "completed"}
    else:
        return {**state, "status": "rejected", "errors": ["Action rejected by user"]}
```

---

## 6. Phase 4: Governance & Observability

### 6.1 OpenLineage Integration

Track full data lineage for compliance (GDPR, SOC2, HIPAA).

```python
from openlineage.client import OpenLineageClient
from openlineage.client.run import Run, RunEvent, RunState

class LineageEmitter:
    def __init__(self, marquez_url: str = "http://localhost:5000"):
        self.client = OpenLineageClient(url=marquez_url)
        self.namespace = "benny"

    def emit_start(self, job_name: str, run_id: str, inputs: list, parent_run_id: str = None):
        """Emit START event when operation begins"""
        event = RunEvent(
            eventType=RunState.START,
            job={"namespace": self.namespace, "name": job_name},
            run=Run(runId=run_id),
            inputs=inputs,
            outputs=[]
        )
        self.client.emit(event)

    def emit_complete(self, job_name: str, run_id: str, outputs: list):
        """Emit COMPLETE event when operation succeeds"""
        event = RunEvent(
            eventType=RunState.COMPLETE,
            job={"namespace": self.namespace, "name": job_name},
            run=Run(runId=run_id),
            inputs=[],
            outputs=outputs
        )
        self.client.emit(event)
```

### 6.2 Distributed Tracing (Phoenix)

```python
from opentelemetry import trace
from opentelemetry.exporter.otlp.proto.grpc.trace_exporter import OTLPSpanExporter

# Initialize Phoenix tracing
def setup_tracing():
    exporter = OTLPSpanExporter(endpoint="http://localhost:4317")
    provider = TracerProvider()
    provider.add_span_processor(BatchSpanProcessor(exporter))
    trace.set_tracer_provider(provider)

tracer = trace.get_tracer("benny")

# Usage in agents
@tracer.start_as_current_span("agent_execution")
def execute_agent(state: GraphState):
    span = trace.get_current_span()
    span.set_attribute("workspace", state["workspace_id"])
    span.set_attribute("model", state.get("model", "default"))
    # ... agent logic
```

### 6.3 Trace Context Propagation

```python
# W3C traceparent format propagation
def propagate_trace(state: GraphState, request_headers: dict) -> GraphState:
    """Extract and propagate trace context through workflow"""
    traceparent = request_headers.get("traceparent")
    if traceparent:
        state["trace_context"] = {"traceparent": traceparent}
    return state
```

---

## 7. Phase 5: Persistence & Durability

### 7.1 Checkpointer Configuration

```python
from langgraph.checkpoint.postgres import PostgresSaver
from langgraph.checkpoint.sqlite import SqliteSaver

# Development: SQLite
checkpointer = SqliteSaver.from_conn_string("benny_checkpoints.db")

# Production: PostgreSQL
checkpointer = PostgresSaver.from_conn_string(
    "postgresql://user:pass@localhost:5432/benny"
)

# Compile graph with checkpointer
app = workflow.compile(checkpointer=checkpointer)

# Execute with thread isolation
result = app.invoke(
    initial_state,
    config={"configurable": {"thread_id": f"user_{user_id}_session_{session_id}"}}
)
```

### 7.2 Time Travel & Debugging

```python
# Get state at any checkpoint
history = list(app.get_state_history(config))
for state in history:
    print(f"Step: {state.metadata['step']}, Time: {state.created_at}")

# Resume from specific checkpoint
app.update_state(config, {"messages": corrected_messages})
result = app.invoke(None, config)  # Resume execution
```

---

## 8. Agent Execution Patterns

### 8.1 Planner Agent - Execution Path

**Input:** Topic, available documents, constraints

**Execution Sequence:**

```
Step 1: Discover Resources
  Thought: I need to understand what's available
  Action: list_available_documents
  Action Input: {"workspace": "{{workspace_id}}"}
  Observation: Found 3 documents: report.pdf, data.csv, notes.md

Step 2: Analyze Content
  Thought: Let me understand the document structure
  Action: search_knowledge_workspace
  Action Input: {"query": "main topics and themes", "workspace": "{{workspace_id}}", "top_k": 10}
  Observation: Key themes: governance, safety, implementation...

Step 3: Create Structured Plan
  Thought: I'll create a plan with clear sections
  Action: write_file
  Action Input: {
    "filename": "plan.json",
    "content": "{\"sections\": [...], \"chunks\": [...]}"
  }
  Observation: Written to plan.json
  📥 Download: http://localhost:8000/api/files/{{workspace}}/plan.json

Step 4: Final Answer
  Final Answer: Created plan with 5 sections and 12 research chunks.
```

### 8.2 Executor Agent - Execution Path

**Input:** Task from plan, context, tools

**Execution Sequence:**

```
Step 1: Retrieve Context
  Thought: I need relevant information for this task
  Action: search_knowledge_workspace
  Action Input: {"query": "{{task_query}}", "workspace": "{{workspace_id}}", "top_k": 5}
  Observation: Found 5 relevant passages...

Step 2: Execute Task
  Thought: Based on the context, I'll generate the output
  Action: write_file
  Action Input: {"filename": "output_{{task_id}}.json", "content": "..."}
  Observation: Written to output_{{task_id}}.json

Step 3: Final Answer
  Final Answer: Completed task {{task_id}}. Output saved.
  📥 Download: http://localhost:8000/api/files/{{workspace}}/output_{{task_id}}.json
```

---

## 9. Deployment Architecture

### 9.1 Development (Docker Compose)

```yaml
version: "3.8"
services:
  benny-api:
    build: .
    ports:
      - "8000:8000"
    environment:
      - OPENAI_API_KEY=${OPENAI_API_KEY}
      - MARQUEZ_URL=http://marquez:5000
      - PHOENIX_URL=http://phoenix:6006
    volumes:
      - ./workspace:/app/workspace

  marquez:
    image: marquezproject/marquez:latest
    ports:
      - "3000:3000" # UI
      - "5000:5000" # API

  phoenix:
    image: arizephoenix/phoenix:latest
    ports:
      - "6006:6006"
```

### 9.2 Production (Kubernetes)

- Helm charts for scalable deployment
- Horizontal pod autoscaling
- Persistent volumes for workspace data
- Secrets management for API keys

---

## 10. API Reference

### Core Endpoints

| Endpoint                        | Method | Description             |
| ------------------------------- | ------ | ----------------------- |
| `/api/workflow/execute`         | POST   | Execute a workflow      |
| `/api/workflow/{id}/status`     | GET    | Get execution status    |
| `/api/workflow/{id}/interrupt`  | POST   | Respond to interrupt    |
| `/api/files/{workspace}/{path}` | GET    | Download generated file |
| `/api/db/search`                | POST   | Search knowledge base   |

### Example Request

```bash
curl -X POST http://localhost:8000/api/workflow/execute \
  -H "Content-Type: application/json" \
  -H "traceparent: 00-abc123-def456-01" \
  -d '{
    "workflow": "report_generator",
    "workspace": "default",
    "params": {
      "topic": "AI Governance Analysis",
      "documents": ["report.pdf"],
      "max_sections": 5
    }
  }'
```

---

## 11. Verification Plan

### 11.1 Automated Tests

```bash
# Test workflow execution
curl -X POST http://localhost:8000/api/workflow/execute \
  -d '{"workflow": "test", "workspace": "default"}'

# Verify lineage in Marquez
curl http://localhost:5000/api/v1/lineage?nodeId=job:benny:test_workflow

# Check Phoenix traces
# Navigate to http://localhost:6006 and verify span hierarchy
```

### 11.2 Governance Verification

1. **Marquez UI** (http://localhost:3000)
   - Verify job lineage graph
   - Check input → output relationships
   - Confirm model usage tracking

2. **Phoenix UI** (http://localhost:6006)
   - Verify trace propagation
   - Check nested spans (workflow → agent → tool → LLM)
   - Review token usage per model

### 11.3 Performance Benchmarks

| Metric           | Target                        | Measurement               |
| ---------------- | ----------------------------- | ------------------------- |
| Workflow latency | <5s for simple tasks          | `phoenix.traces.duration` |
| Token cost       | 40% reduction vs single-model | `lineage.model_usage`     |
| Tracing overhead | <100ms                        | Span timestamps           |

---

## 12. Implementation Checklist

| Phase | Component                           | Status |
| ----- | ----------------------------------- | ------ |
| **1** | State schema (TypedDict)            | ☐      |
| **1** | Multi-model orchestration (LiteLLM) | ☐      |
| **1** | Workspace isolation                 | ☐      |
| **2** | Skills system                       | ☐      |
| **2** | Tool registry                       | ☐      |
| **2** | Pass-by-reference                   | ☐      |
| **3** | StateGraph definition               | ☐      |
| **3** | Conditional routing                 | ☐      |
| **3** | Human-in-the-loop                   | ☐      |
| **4** | OpenLineage integration             | ☐      |
| **4** | Phoenix tracing                     | ☐      |
| **4** | Trace propagation                   | ☐      |
| **5** | Checkpointer (SQLite/Postgres)      | ☐      |
| **5** | Time travel debugging               | ☐      |
| **6** | Docker Compose deployment           | ☐      |
| **6** | API endpoints                       | ☐      |

---

## 13. Summary

| Step  | Component    | Purpose                                                 |
| ----- | ------------ | ------------------------------------------------------- |
| **1** | State Schema | Strict TypedDict for data flow with workspace isolation |
| **2** | Multi-Model  | LiteLLM for 100+ providers with intelligent routing     |
| **3** | Skills/Tools | Python capabilities with pass-by-reference              |
| **4** | StateGraph   | LangGraph nodes with conditional routing                |
| **5** | Governance   | OpenLineage + Phoenix for full auditability             |
| **6** | Checkpointer | Memory, retries, and human interrupts                   |
| **7** | Deployment   | Docker → Kubernetes progression                         |

---

> **Version**: Benny v1.0 - Production-Ready Requirements  
> **Based on**: dangpy v4.1 patterns  
> **Last Updated**: 2026-01-31  
> **Status**: Ready for Implementation

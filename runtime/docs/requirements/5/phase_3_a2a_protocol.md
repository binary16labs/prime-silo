# Phase 3 — Agent2Agent (A2A) Protocol

> **Owner**: Implementation Agent  
> **PRD Reference**: `C:\Users\nsdha\OneDrive\code\benny\docs\requirements\5\PRD_dog_pound.txt`  
> **Parent Plan**: `C:\Users\nsdha\.gemini\antigravity\brain\fd945150-1e44-4e58-baa2-97d8004a2eb2\implementation_plan.md`  
> **Priority**: Enterprise — enables multi-agent collaboration  
> **Estimated Scope**: 1 new package (5 files), 2 new frontend components, 3 modified files

---

## 1. Objective

Implement the **Agent2Agent (A2A) Protocol** as specified in the PRD section "The Agent2Agent (A2A) Protocol Specification". This enables Benny agents to discover each other's capabilities, negotiate interaction modalities, securely delegate tasks, and receive asynchronous results — all via standardized JSON-RPC 2.0 over HTTP(S).

---

## 2. Current State (READ THESE FILES FIRST)

| File | Purpose | Why You Need It |
|------|---------|-----------------|
| `C:\Users\nsdha\OneDrive\code\benny\benny\api\server.py` | FastAPI app, router mounting, governance middleware | You will mount the A2A router here |
| `C:\Users\nsdha\OneDrive\code\benny\benny\api\studio_executor.py` | Studio node execution (trigger, llm, tool, data, logic) | You will add `a2a` node type handler |
| `C:\Users\nsdha\OneDrive\code\benny\frontend\src\components\Studio\WorkflowCanvas.tsx` | ReactFlow canvas with node type registration | You will register the `a2a` node type |
| `C:\Users\nsdha\OneDrive\code\benny\frontend\src\components\Studio\nodes\LLMNode.tsx` | Example custom node component | Follow this pattern for A2ANode |
| `C:\Users\nsdha\OneDrive\code\benny\frontend\src\components\Studio\WorkflowList.tsx` | Sidebar listing (flows/agents mode) | The agents tab will show AgentRegistry |
| `C:\Users\nsdha\OneDrive\code\benny\frontend\src\constants.ts` | API_BASE_URL, GOVERNANCE_HEADERS | Use for all fetch calls |
| `C:\Users\nsdha\OneDrive\code\benny\benny\core\workspace.py` | `get_workspace_path()` | Agent registrations stored under workspace |

---

## 3. Files to Create or Modify

### 3.1 [NEW] `C:\Users\nsdha\OneDrive\code\benny\benny\a2a\__init__.py`

```python
"""
Agent2Agent (A2A) Protocol — Inter-agent communication infrastructure.

Implements the A2A Protocol (Google Cloud, 2025) for:
- Agent capability discovery via Agent Cards
- Standardized task delegation via JSON-RPC 2.0
- Async task management with SSE streaming
- Modality negotiation via UX Parts
"""
```

### 3.2 [NEW] `C:\Users\nsdha\OneDrive\code\benny\benny\a2a\models.py`

All Pydantic models for the A2A protocol. These MUST be exact — they define the wire format.

```python
"""
A2A Protocol Data Models — JSON-RPC 2.0 compliant message types.
"""

from __future__ import annotations
from pydantic import BaseModel, Field
from typing import Optional, List, Dict, Any, Literal
from datetime import datetime
from enum import Enum
import uuid


# =============================================================================
# ENUMS
# =============================================================================

class TaskState(str, Enum):
    """Valid states for an A2A Task."""
    SUBMITTED = "submitted"
    WORKING = "working"
    INPUT_REQUIRED = "input-required"
    COMPLETED = "completed"
    CANCELED = "canceled"
    FAILED = "failed"


class PartType(str, Enum):
    """Content modalities for UX Parts."""
    TEXT = "text"
    JSON_DATA = "json"
    FILE = "file"
    IFRAME = "iframe"
    FORM = "form"


# =============================================================================
# UX PARTS — Modality Negotiation
# =============================================================================

class UXPart(BaseModel):
    """
    A single content part within a message.
    Agents negotiate format using these typed parts.
    """
    type: PartType
    content: str = ""                   # Text content or JSON string
    mime_type: Optional[str] = None     # e.g., "application/json", "text/html"
    uri: Optional[str] = None           # For file or iframe types
    metadata: Dict[str, Any] = Field(default_factory=dict)


# =============================================================================
# MESSAGES
# =============================================================================

class A2AMessage(BaseModel):
    """
    A single exchange turn within a task conversation.
    """
    role: Literal["user", "agent"]
    parts: List[UXPart]
    timestamp: str = Field(default_factory=lambda: datetime.utcnow().isoformat())
    metadata: Dict[str, Any] = Field(default_factory=dict)

    @classmethod
    def text(cls, role: Literal["user", "agent"], content: str) -> "A2AMessage":
        """Convenience method to create a simple text message."""
        return cls(role=role, parts=[UXPart(type=PartType.TEXT, content=content)])


# =============================================================================
# ARTIFACTS
# =============================================================================

class A2AArtifact(BaseModel):
    """
    An output artifact produced by an agent during task execution.
    """
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    name: str
    description: str = ""
    parts: List[UXPart]
    metadata: Dict[str, Any] = Field(default_factory=dict)


# =============================================================================
# TASKS
# =============================================================================

class A2ATask(BaseModel):
    """
    The fundamental unit of work in the A2A protocol.
    """
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    status: TaskState = TaskState.SUBMITTED
    messages: List[A2AMessage] = Field(default_factory=list)
    artifacts: List[A2AArtifact] = Field(default_factory=list)
    metadata: Dict[str, Any] = Field(default_factory=dict)
    created_at: str = Field(default_factory=lambda: datetime.utcnow().isoformat())
    updated_at: str = Field(default_factory=lambda: datetime.utcnow().isoformat())


# =============================================================================
# AGENT CARD — Capability Discovery
# =============================================================================

class AgentSkillCard(BaseModel):
    """A single skill advertised in the Agent Card."""
    id: str
    name: str
    description: str
    input_modes: List[str] = ["text"]     # Supported input modalities
    output_modes: List[str] = ["text"]    # Supported output modalities


class AgentCard(BaseModel):
    """
    Agent Card — the identity and capability manifest of an A2A agent.
    Served at /.well-known/agent.json
    """
    name: str
    description: str
    url: str                              # Base URL of this agent
    version: str = "1.0.0"
    protocol_version: str = "0.2"         # A2A spec version
    skills: List[AgentSkillCard] = Field(default_factory=list)
    auth_required: bool = False
    auth_type: Optional[str] = None       # "api_key", "oauth2", etc.
    supported_input_modes: List[str] = ["text", "json"]
    supported_output_modes: List[str] = ["text", "json"]
    metadata: Dict[str, Any] = Field(default_factory=dict)


# =============================================================================
# JSON-RPC 2.0 Wrappers
# =============================================================================

class JsonRpcRequest(BaseModel):
    """Standard JSON-RPC 2.0 request."""
    jsonrpc: str = "2.0"
    id: Optional[str] = Field(default_factory=lambda: str(uuid.uuid4()))
    method: str
    params: Dict[str, Any] = Field(default_factory=dict)


class JsonRpcResponse(BaseModel):
    """Standard JSON-RPC 2.0 response."""
    jsonrpc: str = "2.0"
    id: Optional[str] = None
    result: Optional[Any] = None
    error: Optional[Dict[str, Any]] = None
```

### 3.3 [NEW] `C:\Users\nsdha\OneDrive\code\benny\benny\a2a\server.py`

This makes the current Benny instance act as an **A2A Server** — capable of receiving tasks from client agents.

```python
"""
A2A Server — Receives and processes tasks from external A2A client agents.

Endpoints:
  POST /a2a/tasks/send         — Receive a new task (JSON-RPC 2.0)
  GET  /a2a/tasks/{task_id}    — Get task status
  POST /a2a/tasks/{task_id}/cancel  — Cancel a task
  GET  /.well-known/agent.json — Serve Agent Card (mounted at app root)
"""

from __future__ import annotations

import logging
import asyncio
from typing import Dict
from datetime import datetime

from fastapi import APIRouter, HTTPException, BackgroundTasks
from fastapi.responses import StreamingResponse

from .models import (
    AgentCard, AgentSkillCard, A2ATask, A2AMessage,
    A2AArtifact, UXPart, PartType, TaskState,
    JsonRpcRequest, JsonRpcResponse,
)

logger = logging.getLogger(__name__)

router = APIRouter()

# In-memory task store (use Redis/SQLite in production)
_tasks: Dict[str, A2ATask] = {}


def _get_agent_card() -> AgentCard:
    """Build the Agent Card for this Benny instance."""
    from ..core.skill_registry import registry
    
    skills = []
    for skill in registry.get_builtin_skills():
        skills.append(AgentSkillCard(
            id=skill.id,
            name=skill.name,
            description=skill.description,
            input_modes=["text", "json"],
            output_modes=["text"],
        ))
    
    return AgentCard(
        name="Benny",
        description="Enterprise Cognitive Mesh orchestration platform with RAG, knowledge graph, and multi-agent swarm capabilities.",
        url="http://localhost:8005",
        version="1.0.0",
        skills=skills,
        auth_required=True,
        auth_type="api_key",
        supported_input_modes=["text", "json"],
        supported_output_modes=["text", "json"],
    )


@router.get("/agent-card")
async def get_agent_card():
    """Return this agent's capability manifest."""
    return _get_agent_card().model_dump()


@router.post("/tasks/send")
async def send_task(request: JsonRpcRequest, background_tasks: BackgroundTasks):
    """
    Receive a task from an A2A client agent.
    JSON-RPC 2.0 method: 'tasks/send'
    """
    if request.method != "tasks/send":
        return JsonRpcResponse(
            id=request.id,
            error={"code": -32601, "message": f"Method not found: {request.method}"}
        ).model_dump()
    
    # Extract task parameters
    params = request.params
    message_text = params.get("message", "")
    workspace = params.get("workspace", "default")
    model = params.get("model", "Qwen3-8B-Hybrid")
    
    # Create task
    task = A2ATask(
        messages=[A2AMessage.text("user", message_text)],
        metadata={"workspace": workspace, "model": model, "source": "a2a_client"},
    )
    _tasks[task.id] = task
    
    # Execute asynchronously
    background_tasks.add_task(_execute_task, task.id, workspace, model)
    
    return JsonRpcResponse(
        id=request.id,
        result=task.model_dump()
    ).model_dump()


async def _execute_task(task_id: str, workspace: str, model: str):
    """Background execution of an A2A task."""
    task = _tasks.get(task_id)
    if not task:
        return
    
    task.status = TaskState.WORKING
    task.updated_at = datetime.utcnow().isoformat()
    
    try:
        # Get the user message
        user_message = ""
        for msg in task.messages:
            if msg.role == "user":
                for part in msg.parts:
                    if part.type == PartType.TEXT:
                        user_message += part.content
        
        # Execute using the synthesis engine or call_model
        from ..core.models import call_model
        
        result = await call_model(
            model=model,
            messages=[
                {"role": "system", "content": "You are a helpful AI agent responding to a delegated task from another agent."},
                {"role": "user", "content": user_message},
            ],
            temperature=0.7,
            max_tokens=2000,
        )
        
        # Add response message
        task.messages.append(A2AMessage.text("agent", result))
        
        # Create artifact
        task.artifacts.append(A2AArtifact(
            name="response",
            description="Agent response to delegated task",
            parts=[UXPart(type=PartType.TEXT, content=result)],
        ))
        
        task.status = TaskState.COMPLETED
        
    except Exception as e:
        logger.error("A2A task execution failed: %s", e)
        task.messages.append(A2AMessage.text("agent", f"Task failed: {str(e)}"))
        task.status = TaskState.FAILED
    
    task.updated_at = datetime.utcnow().isoformat()


@router.get("/tasks/{task_id}")
async def get_task(task_id: str):
    """Get the current state of a task."""
    task = _tasks.get(task_id)
    if not task:
        raise HTTPException(404, f"Task not found: {task_id}")
    return task.model_dump()


@router.post("/tasks/{task_id}/cancel")
async def cancel_task(task_id: str):
    """Cancel a running task."""
    task = _tasks.get(task_id)
    if not task:
        raise HTTPException(404, f"Task not found: {task_id}")
    task.status = TaskState.CANCELED
    task.updated_at = datetime.utcnow().isoformat()
    return {"status": "canceled", "task_id": task_id}
```

### 3.4 [NEW] `C:\Users\nsdha\OneDrive\code\benny\benny\a2a\client.py`

This provides the client side — allowing Benny to delegate tasks TO external A2A agents.

```python
"""
A2A Client — Delegates tasks to external A2A-compatible agents.

Usage:
    client = A2AClient()
    card = await client.discover_agent("http://remote-agent:8005")
    task = await client.send_task("http://remote-agent:8005", "Analyze this document...")
    result = await client.poll_until_complete("http://remote-agent:8005", task.id)
"""

from __future__ import annotations

import logging
import asyncio
from typing import Optional, AsyncIterator

import httpx

from .models import AgentCard, A2ATask, JsonRpcRequest, JsonRpcResponse, TaskState

logger = logging.getLogger(__name__)

DEFAULT_TIMEOUT = 300.0  # 5 minutes
POLL_INTERVAL = 2.0  # seconds


class A2AClientError(Exception):
    """Raised when an A2A client operation fails."""
    pass


class A2AClient:
    """
    Client for interacting with remote A2A-compatible agents.
    """
    
    def __init__(self, api_key: Optional[str] = None, timeout: float = DEFAULT_TIMEOUT):
        self.api_key = api_key
        self.timeout = timeout
    
    def _headers(self) -> dict:
        headers = {"Content-Type": "application/json"}
        if self.api_key:
            headers["X-Benny-API-Key"] = self.api_key
        return headers
    
    async def discover_agent(self, agent_url: str) -> AgentCard:
        """
        Fetch a remote agent's Agent Card for capability discovery.
        
        Tries: /.well-known/agent.json first, then /a2a/agent-card
        
        Args:
            agent_url: Base URL of the remote agent (e.g., "http://remote:8005")
        
        Returns:
            AgentCard with the agent's capabilities
        
        Raises:
            A2AClientError: If discovery fails
        """
        async with httpx.AsyncClient(timeout=self.timeout) as client:
            # Try well-known path first
            for path in ["/.well-known/agent.json", "/a2a/agent-card"]:
                try:
                    response = await client.get(
                        f"{agent_url.rstrip('/')}{path}",
                        headers=self._headers()
                    )
                    if response.status_code == 200:
                        return AgentCard(**response.json())
                except Exception:
                    continue
            
            raise A2AClientError(f"Could not discover agent at {agent_url}")
    
    async def send_task(
        self,
        agent_url: str,
        message: str,
        workspace: str = "default",
        model: Optional[str] = None,
    ) -> A2ATask:
        """
        Send a task to a remote A2A agent.
        
        Args:
            agent_url: Base URL of the target agent
            message: Task description / user message
            workspace: Workspace context
            model: Optional model override
        
        Returns:
            A2ATask with initial status (usually SUBMITTED or WORKING)
        """
        request = JsonRpcRequest(
            method="tasks/send",
            params={
                "message": message,
                "workspace": workspace,
                **({"model": model} if model else {}),
            }
        )
        
        async with httpx.AsyncClient(timeout=self.timeout) as client:
            try:
                response = await client.post(
                    f"{agent_url.rstrip('/')}/a2a/tasks/send",
                    json=request.model_dump(),
                    headers=self._headers(),
                )
                
                if response.status_code != 200:
                    raise A2AClientError(f"Task send failed: {response.status_code} {response.text}")
                
                rpc_response = JsonRpcResponse(**response.json())
                
                if rpc_response.error:
                    raise A2AClientError(f"RPC error: {rpc_response.error}")
                
                return A2ATask(**rpc_response.result)
                
            except httpx.RequestError as e:
                raise A2AClientError(f"Connection failed: {str(e)}")
    
    async def get_task_status(self, agent_url: str, task_id: str) -> A2ATask:
        """
        Check the current status of a task.
        
        Args:
            agent_url: Base URL of the agent handling the task
            task_id: ID of the task to check
        
        Returns:
            Updated A2ATask
        """
        async with httpx.AsyncClient(timeout=self.timeout) as client:
            response = await client.get(
                f"{agent_url.rstrip('/')}/a2a/tasks/{task_id}",
                headers=self._headers(),
            )
            
            if response.status_code == 404:
                raise A2AClientError(f"Task not found: {task_id}")
            if response.status_code != 200:
                raise A2AClientError(f"Status check failed: {response.status_code}")
            
            return A2ATask(**response.json())
    
    async def poll_until_complete(
        self,
        agent_url: str,
        task_id: str,
        poll_interval: float = POLL_INTERVAL,
        max_wait: float = 600.0,
    ) -> A2ATask:
        """
        Poll a task until it reaches a terminal state.
        
        Terminal states: COMPLETED, FAILED, CANCELED
        
        Args:
            agent_url: Base URL of the agent
            task_id: Task to poll
            poll_interval: Seconds between poll attempts
            max_wait: Maximum total wait time in seconds
        
        Returns:
            Final A2ATask state
        
        Raises:
            A2AClientError: If max_wait is exceeded
        """
        elapsed = 0.0
        while elapsed < max_wait:
            task = await self.get_task_status(agent_url, task_id)
            
            if task.status in (TaskState.COMPLETED, TaskState.FAILED, TaskState.CANCELED):
                return task
            
            await asyncio.sleep(poll_interval)
            elapsed += poll_interval
        
        raise A2AClientError(f"Task {task_id} did not complete within {max_wait}s")
    
    async def cancel_task(self, agent_url: str, task_id: str) -> dict:
        """Cancel a running task."""
        async with httpx.AsyncClient(timeout=self.timeout) as client:
            response = await client.post(
                f"{agent_url.rstrip('/')}/a2a/tasks/{task_id}/cancel",
                headers=self._headers(),
            )
            return response.json()
```

### 3.5 [NEW] `C:\Users\nsdha\OneDrive\code\benny\benny\a2a\registry.py`

File-based registry for discovered agents, persisted under `workspace/agents/`.

```python
"""
A2A Agent Registry — Local storage for discovered external agents.

Agents are stored as JSON files under workspace/agents/<agent_id>.json
"""

from __future__ import annotations

import json
import logging
from typing import List, Optional, Dict
from pathlib import Path
import hashlib

from .models import AgentCard
from ..core.workspace import get_workspace_path

logger = logging.getLogger(__name__)


class AgentRegistry:
    """
    Manages registered A2A agents for a workspace.
    """
    
    def _agents_dir(self, workspace: str) -> Path:
        """Get agents directory for a workspace, creating if needed."""
        agents_dir = get_workspace_path(workspace) / "agents"
        agents_dir.mkdir(parents=True, exist_ok=True)
        return agents_dir
    
    def _agent_id(self, url: str) -> str:
        """Generate a deterministic agent ID from URL."""
        return hashlib.md5(url.encode()).hexdigest()[:12]
    
    def register_agent(self, workspace: str, agent_card: AgentCard) -> Dict:
        """
        Register or update an agent in the workspace registry.
        
        Args:
            workspace: Target workspace
            agent_card: Agent's capability manifest
        
        Returns:
            Registration status dict
        """
        agent_id = self._agent_id(agent_card.url)
        file_path = self._agents_dir(workspace) / f"{agent_id}.json"
        
        data = agent_card.model_dump()
        data["_registry_id"] = agent_id
        
        file_path.write_text(json.dumps(data, indent=2), encoding="utf-8")
        
        return {"status": "registered", "agent_id": agent_id, "name": agent_card.name}
    
    def list_agents(self, workspace: str) -> List[AgentCard]:
        """List all registered agents in a workspace."""
        agents = []
        agents_dir = self._agents_dir(workspace)
        
        for file in agents_dir.glob("*.json"):
            try:
                data = json.loads(file.read_text(encoding="utf-8"))
                data.pop("_registry_id", None)
                agents.append(AgentCard(**data))
            except Exception as e:
                logger.warning("Could not load agent %s: %s", file, e)
        
        return agents
    
    def get_agent(self, workspace: str, agent_id: str) -> Optional[AgentCard]:
        """Get a specific registered agent."""
        file_path = self._agents_dir(workspace) / f"{agent_id}.json"
        if not file_path.exists():
            return None
        
        data = json.loads(file_path.read_text(encoding="utf-8"))
        data.pop("_registry_id", None)
        return AgentCard(**data)
    
    def find_agent_for_skill(self, workspace: str, skill_name: str) -> Optional[AgentCard]:
        """Find an agent that advertises a specific skill."""
        for agent in self.list_agents(workspace):
            for skill in agent.skills:
                if skill.id == skill_name or skill_name.lower() in skill.name.lower():
                    return agent
        return None
    
    def remove_agent(self, workspace: str, agent_id: str) -> Dict:
        """Remove an agent from the registry."""
        file_path = self._agents_dir(workspace) / f"{agent_id}.json"
        if not file_path.exists():
            return {"status": "not_found", "agent_id": agent_id}
        file_path.unlink()
        return {"status": "removed", "agent_id": agent_id}


# Global registry instance
agent_registry = AgentRegistry()
```

### 3.6 [MODIFY] `C:\Users\nsdha\OneDrive\code\benny\benny\api\server.py`

Add these changes:

1. Import the A2A router:
```python
from ..a2a.server import router as a2a_router
```

2. Mount the router:
```python
app.include_router(a2a_router, prefix="/a2a", tags=["Agent2Agent"])
```

3. Add the well-known endpoint (at root level, NOT under /a2a prefix):
```python
@app.get("/.well-known/agent.json")
async def well_known_agent_card():
    """Serve Agent Card at the well-known discovery path."""
    from benny.a2a.server import _get_agent_card
    return _get_agent_card().model_dump()
```

4. Add to GOVERNANCE_WHITELIST:
```python
GOVERNANCE_WHITELIST = [
    # ... existing entries ...
    "/.well-known/agent.json",  # A2A discovery must be public
]
```

### 3.7 [MODIFY] `C:\Users\nsdha\OneDrive\code\benny\benny\api\studio_executor.py`

Add handler for `a2a` node type in the main execution loop. In `execute_studio_workflow()`, add this case in the node type switch:

```python
elif node.type == "a2a":
    output = await execute_a2a_node(node, context, request.workspace)
    if output.get("response"):
        context["llm_output"] = output["response"]
        final_output = output["response"]
```

Add the execution function:

```python
async def execute_a2a_node(node: StudioNode, context: Dict, workspace: str) -> Dict:
    """Execute an A2A delegation node — sends task to a remote agent."""
    from ..a2a.client import A2AClient, A2AClientError
    
    config = node.data.get("config") or {}
    agent_url = config.get("agentUrl", "")
    timeout = float(config.get("timeout", 300))
    
    if not agent_url:
        return {"error": "No agent URL configured", "response": None}
    
    message = context.get("message", "") or context.get("llm_output", "")
    
    try:
        client = A2AClient(api_key="benny-mesh-2026-auth", timeout=timeout)
        
        # Send task
        task = await client.send_task(agent_url, message, workspace)
        
        # Poll for completion
        final_task = await client.poll_until_complete(
            agent_url, task.id,
            max_wait=timeout
        )
        
        # Extract response
        response_text = ""
        for msg in final_task.messages:
            if msg.role == "agent":
                for part in msg.parts:
                    if part.type.value == "text":
                        response_text += part.content
        
        return {
            "response": response_text,
            "task_id": final_task.id,
            "status": final_task.status.value,
            "artifacts": [a.model_dump() for a in final_task.artifacts],
        }
    except A2AClientError as e:
        return {"error": str(e), "response": None}
    except Exception as e:
        return {"error": f"A2A execution failed: {str(e)}", "response": None}
```

### 3.8 [NEW] `C:\Users\nsdha\OneDrive\code\benny\frontend\src\components\Studio\nodes\A2ANode.tsx`

Follow the exact pattern of `LLMNode.tsx` but for A2A delegation:

```tsx
import { memo } from 'react';
import { Handle, Position } from '@xyflow/react';
import type { NodeProps } from '@xyflow/react';
import { Globe } from 'lucide-react';

function A2ANode({ data, selected }: NodeProps) {
  const status = data.status as string;
  const config = (data.config || {}) as { agentUrl?: string; agentName?: string };

  return (
    <div className={`workflow-node a2a-node ${selected ? 'selected' : ''} ${status || ''}`}
      style={{
        background: 'linear-gradient(135deg, rgba(14, 165, 233, 0.15), rgba(59, 130, 246, 0.1))',
        border: `2px solid ${selected ? '#0ea5e3' : status === 'error' ? '#ef4444' : status === 'success' ? '#22c55e' : 'rgba(14, 165, 233, 0.4)'}`,
        borderRadius: '12px',
        padding: '12px 16px',
        minWidth: '180px',
        cursor: 'pointer',
      }}>
      <Handle type="target" position={Position.Top} style={{ background: '#0ea5e3' }} />
      
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' }}>
        <Globe size={16} style={{ color: '#0ea5e3' }} />
        <span style={{ fontSize: '13px', fontWeight: 600, color: '#fff' }}>
          {(data.label as string) || 'A2A Agent'}
        </span>
      </div>
      
      {config.agentName && (
        <div style={{ fontSize: '11px', color: 'rgba(255,255,255,0.6)' }}>
          → {config.agentName}
        </div>
      )}
      {config.agentUrl && (
        <div style={{ fontSize: '10px', color: 'rgba(255,255,255,0.4)', fontFamily: 'monospace' }}>
          {config.agentUrl}
        </div>
      )}
      
      {status && (
        <div style={{
          fontSize: '10px',
          marginTop: '6px',
          padding: '2px 6px',
          borderRadius: '4px',
          background: status === 'success' ? 'rgba(34,197,94,0.2)' : status === 'error' ? 'rgba(239,68,68,0.2)' : 'rgba(14,165,233,0.2)',
          color: status === 'success' ? '#22c55e' : status === 'error' ? '#ef4444' : '#0ea5e3',
          display: 'inline-block',
        }}>
          {status}
        </div>
      )}
      
      <Handle type="source" position={Position.Bottom} style={{ background: '#0ea5e3' }} />
    </div>
  );
}

export default memo(A2ANode);
```

### 3.9 [MODIFY] `C:\Users\nsdha\OneDrive\code\benny\frontend\src\components\Studio\WorkflowCanvas.tsx`

Add the A2A node type:

1. Add import at top:
```tsx
import A2ANode from './nodes/A2ANode';
```

2. Add to `nodeTypes`:
```tsx
const nodeTypes: NodeTypes = useMemo(() => ({
    trigger: TriggerNode,
    llm: LLMNode,
    tool: ToolNode,
    logic: LogicNode,
    data: DataNode,
    a2a: A2ANode,  // NEW
}), []);
```

3. Add to MiniMap color mapping:
```tsx
case 'a2a': return '#0ea5e3';
```

### 3.10 [MODIFY] `C:\Users\nsdha\OneDrive\code\benny\frontend\src\components\Studio\ConfigPanel.tsx`

Add configuration section for A2A nodes. After the `node.type === 'logic'` block, add:

```tsx
{node.type === 'a2a' && (
  <>
    <div className="form-group">
      <label className="form-label" htmlFor="agent-url">Agent URL</label>
      <input
        id="agent-url"
        type="text"
        className="form-input"
        placeholder="http://remote-agent:8005"
        value={(node.data.config as any)?.agentUrl || ''}
        onChange={(e) => handleConfigChange('agentUrl', e.target.value)}
      />
    </div>
    <div className="form-group">
      <label className="form-label" htmlFor="agent-timeout">Timeout (seconds)</label>
      <input
        id="agent-timeout"
        type="number"
        className="form-input"
        min={10}
        max={3600}
        value={(node.data.config as any)?.timeout || 300}
        onChange={(e) => handleConfigChange('timeout', e.target.value)}
      />
    </div>
    <button
      className="btn btn-outline"
      style={{ width: '100%', marginTop: '8px' }}
      onClick={async () => {
        const url = (node.data.config as any)?.agentUrl;
        if (!url) return alert('Enter an agent URL first');
        try {
          const res = await fetch(`${url}/.well-known/agent.json`);
          if (res.ok) {
            const card = await res.json();
            handleConfigChange('agentName', card.name);
            alert(`Discovered: ${card.name}\nSkills: ${card.skills?.map((s: any) => s.name).join(', ')}`);
          } else {
            alert('Agent not found at that URL');
          }
        } catch {
          alert('Could not connect to agent');
        }
      }}
    >
      🔍 Discover Agent
    </button>
  </>
)}
```

### 3.11 [MODIFY] `C:\Users\nsdha\OneDrive\code\benny\frontend\src\components\Studio\NodePalette.tsx`

Add the A2A node to the draggable palette. Find the node list and add:

```tsx
{ type: 'a2a', label: '🌐 A2A Agent', description: 'Delegate to external agent' }
```

---

## 4. BDD Acceptance Criteria

```gherkin
Feature: A2A Agent Card Discovery

  Scenario: Benny serves its own Agent Card
    When I GET "/.well-known/agent.json"
    Then the response should contain "name" equal to "Benny"
    And the response should contain a "skills" array
    And the response should contain "protocol_version"

  Scenario: Client discovers a remote agent
    Given a remote Benny instance is running at "http://localhost:8006"
    When the A2A client calls discover_agent("http://localhost:8006")
    Then an AgentCard should be returned with the remote agent's skills

Feature: A2A Task Delegation

  Scenario: Send and complete a task
    Given the A2A server is running
    When a client sends a task with message "Summarize this document"
    Then a task should be created with status "submitted"
    And the task should eventually reach status "completed"
    And the task should have at least one agent message

  Scenario: Task polling returns correct status
    Given a task has been submitted
    When the client polls GET /a2a/tasks/{task_id}
    Then the response should contain the task with current status

  Scenario: Task cancellation
    Given a running task
    When the client sends POST /a2a/tasks/{task_id}/cancel
    Then the task status should become "canceled"

Feature: A2A Studio Node

  Scenario: A2A node appears in the palette
    Given the Studio is loaded
    Then the node palette should contain "A2A Agent" option

  Scenario: A2A node configuration
    Given an A2A node is on the canvas
    When I click on it
    Then the ConfigPanel should show Agent URL input
    And the ConfigPanel should show a Discover Agent button
    And the ConfigPanel should show a Timeout input

  Scenario: A2A node execution
    Given an A2A node is configured with a valid agent URL
    And the workflow is: Trigger → A2A Agent
    When I execute the workflow with message "Hello"
    Then the A2A node should delegate to the remote agent
    And the result should contain the agent's response
```

---

## 5. TDD Test File

### Create: `C:\Users\nsdha\OneDrive\code\benny\tests\test_a2a.py`

```python
"""
Test suite for Phase 3 — Agent2Agent Protocol.
Run with: python -m pytest tests/test_a2a.py -v
"""

import pytest
import asyncio
from unittest.mock import patch, AsyncMock, MagicMock

from benny.a2a.models import (
    AgentCard, AgentSkillCard, A2ATask, A2AMessage,
    A2AArtifact, UXPart, PartType, TaskState,
    JsonRpcRequest, JsonRpcResponse,
)
from benny.a2a.registry import AgentRegistry


class TestA2AModels:

    def test_agent_card_serialization(self):
        card = AgentCard(name="Test", description="Test agent", url="http://localhost:8005")
        data = card.model_dump()
        assert data["name"] == "Test"
        assert data["protocol_version"] == "0.2"

    def test_task_creation(self):
        task = A2ATask()
        assert task.status == TaskState.SUBMITTED
        assert len(task.id) > 0

    def test_message_text_convenience(self):
        msg = A2AMessage.text("user", "Hello")
        assert msg.role == "user"
        assert len(msg.parts) == 1
        assert msg.parts[0].type == PartType.TEXT
        assert msg.parts[0].content == "Hello"

    def test_json_rpc_request(self):
        req = JsonRpcRequest(method="tasks/send", params={"message": "test"})
        assert req.jsonrpc == "2.0"
        assert req.method == "tasks/send"

    def test_task_state_transitions(self):
        task = A2ATask()
        assert task.status == TaskState.SUBMITTED
        task.status = TaskState.WORKING
        assert task.status == TaskState.WORKING
        task.status = TaskState.COMPLETED
        assert task.status == TaskState.COMPLETED


class TestAgentRegistry:

    def test_register_and_list(self, tmp_path):
        registry = AgentRegistry()
        card = AgentCard(name="Remote", description="Remote agent", url="http://remote:8005")
        
        with patch.object(registry, '_agents_dir', return_value=tmp_path):
            result = registry.register_agent("test", card)
            assert result["status"] == "registered"
            
            agents = registry.list_agents("test")
            assert len(agents) == 1
            assert agents[0].name == "Remote"

    def test_find_agent_for_skill(self, tmp_path):
        registry = AgentRegistry()
        card = AgentCard(
            name="SearchAgent", 
            description="Agent with search", 
            url="http://search:8005",
            skills=[AgentSkillCard(id="web_search", name="Web Search", description="Search the web")]
        )
        
        with patch.object(registry, '_agents_dir', return_value=tmp_path):
            registry.register_agent("test", card)
            found = registry.find_agent_for_skill("test", "web_search")
            assert found is not None
            assert found.name == "SearchAgent"

    def test_find_nonexistent_skill(self, tmp_path):
        registry = AgentRegistry()
        with patch.object(registry, '_agents_dir', return_value=tmp_path):
            found = registry.find_agent_for_skill("test", "nonexistent")
            assert found is None

    def test_remove_agent(self, tmp_path):
        registry = AgentRegistry()
        card = AgentCard(name="Temp", description="Temp", url="http://temp:8005")
        
        with patch.object(registry, '_agents_dir', return_value=tmp_path):
            result = registry.register_agent("test", card)
            agent_id = result["agent_id"]
            
            remove_result = registry.remove_agent("test", agent_id)
            assert remove_result["status"] == "removed"
            
            agents = registry.list_agents("test")
            assert len(agents) == 0


class TestA2AClient:

    @pytest.mark.asyncio
    async def test_discover_agent(self):
        from benny.a2a.client import A2AClient
        
        mock_card = {"name": "Test", "description": "Test", "url": "http://test:8005", "skills": [], "version": "1.0.0", "protocol_version": "0.2", "auth_required": False}
        
        with patch("httpx.AsyncClient") as MockClient:
            mock_instance = AsyncMock()
            mock_response = MagicMock()
            mock_response.status_code = 200
            mock_response.json.return_value = mock_card
            mock_instance.get = AsyncMock(return_value=mock_response)
            mock_instance.__aenter__ = AsyncMock(return_value=mock_instance)
            mock_instance.__aexit__ = AsyncMock(return_value=None)
            MockClient.return_value = mock_instance
            
            client = A2AClient()
            card = await client.discover_agent("http://test:8005")
            assert card.name == "Test"

    @pytest.mark.asyncio
    async def test_poll_until_complete(self):
        from benny.a2a.client import A2AClient
        
        client = A2AClient()
        
        task_data = {
            "id": "test-123",
            "status": "completed",
            "messages": [{"role": "agent", "parts": [{"type": "text", "content": "Done"}], "timestamp": "2026-01-01"}],
            "artifacts": [],
            "metadata": {},
            "created_at": "2026-01-01",
            "updated_at": "2026-01-01",
        }
        
        with patch.object(client, 'get_task_status', new_callable=AsyncMock) as mock_status:
            mock_status.return_value = A2ATask(**task_data)
            result = await client.poll_until_complete("http://test:8005", "test-123")
            assert result.status == TaskState.COMPLETED
```

---

## 6. Execution Order

1. Read ALL files in Section 2
2. Create `C:\Users\nsdha\OneDrive\code\benny\tests\test_a2a.py` (tests first)
3. Create `C:\Users\nsdha\OneDrive\code\benny\benny\a2a\__init__.py`
4. Create `C:\Users\nsdha\OneDrive\code\benny\benny\a2a\models.py`
5. Create `C:\Users\nsdha\OneDrive\code\benny\benny\a2a\registry.py`
6. Run model + registry tests: `python -m pytest tests/test_a2a.py -v -k "Models or Registry"`
7. Create `C:\Users\nsdha\OneDrive\code\benny\benny\a2a\server.py`
8. Create `C:\Users\nsdha\OneDrive\code\benny\benny\a2a\client.py`
9. Run full test suite: `python -m pytest tests/test_a2a.py -v`
10. Modify `C:\Users\nsdha\OneDrive\code\benny\benny\api\server.py` — mount A2A router
11. Modify `C:\Users\nsdha\OneDrive\code\benny\benny\api\studio_executor.py` — add a2a handler
12. Create `C:\Users\nsdha\OneDrive\code\benny\frontend\src\components\Studio\nodes\A2ANode.tsx`
13. Modify `C:\Users\nsdha\OneDrive\code\benny\frontend\src\components\Studio\WorkflowCanvas.tsx`
14. Modify `C:\Users\nsdha\OneDrive\code\benny\frontend\src\components\Studio\ConfigPanel.tsx`
15. Modify `C:\Users\nsdha\OneDrive\code\benny\frontend\src\components\Studio\NodePalette.tsx`
16. Start backend and verify: `curl http://localhost:8005/.well-known/agent.json`

---

## 7. Definition of Done

- [ ] All tests in `test_a2a.py` pass
- [ ] `GET /.well-known/agent.json` returns a valid Agent Card
- [ ] `POST /a2a/tasks/send` creates and executes a task
- [ ] `GET /a2a/tasks/{id}` returns current task state
- [ ] A2A node appears in the Studio palette and can be dragged to canvas
- [ ] A2A node ConfigPanel shows URL, timeout, and Discover button
- [ ] Agent Registry persists discovered agents to workspace/agents/ directory
- [ ] Studio workflow with trigger → A2A node executes end-to-end
- [ ] No new linting errors in Python or TypeScript

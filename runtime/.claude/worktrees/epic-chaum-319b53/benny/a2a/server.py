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

# In-memory pulse log
_pulse_messages: list = []

def _log_pulse(sender: str, receiver: str, content: str):
    """Adds a message to the A2A pulse log."""
    _pulse_messages.append({
        "id": f"p-{datetime.now().timestamp()}",
        "from": sender,
        "to": receiver,
        "content": content[:200] + ("..." if len(content) > 200 else ""),
        "timestamp": datetime.utcnow().isoformat()
    })
    # Keep last 50
    if len(_pulse_messages) > 50:
        _pulse_messages.pop(0)


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


@router.get("/pulse")
async def get_pulse():
    """Get the live A2A message feed."""
    return {"messages": _pulse_messages[::-1]}


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
    
    _log_pulse("A2A Client", "Benny", f"Assigned task: {message_text[:50]}...")
    
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
        _log_pulse("Benny", "A2A Client", f"Task complete: {result[:50]}...")
        
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

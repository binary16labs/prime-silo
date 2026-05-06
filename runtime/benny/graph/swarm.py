"""
Benny Swarm Graph - LangGraph implementation for parallel task orchestration

Architecture:
- Planner: Bricoleur that decomposes requests, looks for existing skills
- Orchestrator: Reviews plan, uses Command for atomic state+navigation
- Dispatcher: Fan-out via Send API with semaphore-controlled concurrency
- Executor: Code Execution pattern with skill lookup
- Aggregator: Kludge-style graceful degradation for partial failures
"""

from __future__ import annotations

import logging
import os
import json
import asyncio
import uuid
import re
from datetime import datetime
from typing import Literal, Optional, List, Dict, Any, Tuple
from pathlib import Path

from langgraph.graph import StateGraph, START, END
from langgraph.types import Send, Command
from langgraph.checkpoint.memory import MemorySaver
from langchain_core.messages import HumanMessage, AIMessage, SystemMessage
from litellm import completion, acompletion

logger = logging.getLogger(__name__)

from ..core.state import SwarmState, TaskItem, PartialResult, create_swarm_state
from ..core.workspace import get_workspace_path
from ..core.models import MODEL_REGISTRY, get_model_config, call_model
from ..governance.lineage import (
    track_workflow_start, 
    track_workflow_complete,
    get_lineage_client
)
from .wave_scheduler import (
    compute_waves,
    detect_conflicts,
    resolve_conflicts,
    generate_ascii_dag,
    assign_models,
    CircularDependencyError,
)
from ..governance.permission_manifest import create_ephemeral_manifest, register_manifest
from ..core.skill_registry import registry
from ..core.task_manager import task_manager
from ..core.event_bus import event_bus
from ..core.reasoning import extract_reasoning
from ..core.artifact_store import (
    maybe_promote,
    resolve_uris_in_args,
    DEFAULT_PBR_THRESHOLD_TOKENS,
)



# =============================================================================
# UTILS
# =============================================================================

def parse_json_safe(text: str) -> Tuple[Dict[str, Any], str]:
    """
    Robust JSON parsing that handles:
    - Extraction of <think> blocks (reasoning)
    - Leading/trailing garbage
    - Markdown code blocks
    - Simple truncation
    - Trailing commas
    """
    # Extract and strip reasoning/think blocks
    cleaned, thinking = extract_reasoning(text)
    
    # Remove markdown code fences
    if "```json" in cleaned:
        cleaned = cleaned.split("```json")[1].split("```")[0]
    elif "```" in cleaned:
        blocks = cleaned.split("```")
        for block in blocks:
            if "{" in block and ":" in block:
                cleaned = block
                break
        else:
            cleaned = blocks[1] if len(blocks) > 1 else cleaned
    
    cleaned = cleaned.strip()
    
    # Boundary detection: Find first '{' or '['
    start_idx = -1
    for i, char in enumerate(cleaned):
        if char in "{[":
            start_idx = i
            break
    
    if start_idx != -1:
        cleaned = cleaned[start_idx:]
    
    # Boundary detection: Find last '}' or ']'
    end_idx = -1
    for i in range(len(cleaned) - 1, -1, -1):
        if cleaned[i] in "}]":
            end_idx = i
            break
            
    if end_idx != -1:
        cleaned = cleaned[:end_idx + 1]
    
    if not cleaned:
        raise ValueError("Could not find any JSON structure in text")

    # Clean up trailing commas in objects/arrays (common model error)
    cleaned = re.sub(r',\s*([\]}])', r'\1', cleaned)

    # 1. Handle missing commas between properties/items (common in some local models)
    # Match "... "value" "next_key": ..." or "... } { ..."
    # This regex handles both string values and non-string values (numbers, booleans, null)
    cleaned = re.sub(r'("(?:\\["\\\/bfnrt]|\\u[0-9a-fA-F]{4}|[^"\\\x00-\x1f])*"\s*:\s*(?:"(?:\\["\\\/bfnrt]|\\u[0-9a-fA-F]{4}|[^"\\\x00-\x1f])*"|[^,\s{}[]]+))\s*(")', r'\1, \2', cleaned)
    cleaned = re.sub(r'(\})\s*(\{)', r'\1, \2', cleaned)
    cleaned = re.sub(r'(\])\s*(\[)', r'\1, \2', cleaned)

    # 2. Balance strings and brackets
    # This must be done carefully to handle truncated strings or objects
    
    # First: identify open strings and brackets
    stack = []
    in_string = False
    escaped = False
    for char in cleaned:
        if char == "\\" and not escaped:
            escaped = True
            continue
        if char == '"' and not escaped:
            in_string = not in_string
        elif not in_string:
            if char in "{[":
                stack.append(char)
            elif char == "}":
                if stack and stack[-1] == "{": stack.pop()
            elif char == "]":
                if stack and stack[-1] == "[": stack.pop()
        escaped = False
    
    # Repair
    if in_string:
        cleaned += '"'
    
    while stack:
        cleaned = cleaned.rstrip(", :\n\r\t")
        top = stack.pop()
        if top == "{": cleaned += "}"
        else: cleaned += "]"
    
    try:
        return json.loads(cleaned), thinking
    except json.JSONDecodeError as e:
        # Emergency repair for truncated properties like "key": "val
        if "Expecting" in str(e) and not (cleaned.endswith("}") or cleaned.endswith("]")):
             try:
                 # Try adding a recursive set of closers
                 repair_attempt = cleaned.rstrip(", :") + "}"
                 return json.loads(repair_attempt), thinking
             except:
                 pass
                
        logger.debug(f"JSON repair failed. Original length: {len(text)}, Cleaned: {cleaned[:100]}...")
        raise e

MAX_CONCURRENCY = int(os.getenv("SWARM_MAX_CONCURRENCY", "1"))
MARQUEZ_WEB_URL = os.getenv("MARQUEZ_WEB_URL", "http://localhost:3000")


def get_governance_url(execution_id: str, workflow_name: str = "swarm") -> str:
    """Generate direct link to Marquez lineage visualization"""
    return f"{MARQUEZ_WEB_URL}/lineage/benny/workflow.{workflow_name}/{execution_id}"


def discover_skills(workspace_id: str = "default") -> List[Dict[str, Any]]:
    """Refactored to use the central SkillRegistry."""
    skills = registry.get_all_skills(workspace_id)
    return [s.to_dict() for s in skills]




def normalize_model_string(model_id: str) -> str:
    """Normalize model string for LiteLLM targeting local providers."""
    if not model_id:
        return model_id
    
    # Prefix mapping for LiteLLM to use its OpenAI-compatible client
    local_mapping = ["lemonade", "fastflowlm", "lmstudio", "ollama"]
    
    # Parse provider from LiteLLM style string 'provider/model'
    if "/" in model_id and not model_id.startswith("openai/"):
        provider = model_id.split("/")[0].lower()
        if provider in local_mapping:
            core_model = "/".join(model_id.split("/")[1:])
            # Lemonade is strict and doesn't want the prefix in the JSON body,
            # but LiteLLM needs it in the 'model' string for routing.
            # FastFlowLM and Ollama usually accept openai/ prefix.
            return f"openai/{core_model}"
            
    return model_id


# =============================================================================
# NODE: PLANNER (Bricoleur)
# =============================================================================

async def planner_node(state: SwarmState) -> Dict[str, Any]:
    """
    Hierarchical Planner Node - supports Macro Strategy and JIT Micro Expansion.
    """
    workspace_id = state.get("workspace", "default")
    execution_id = state.get("execution_id", "")
    request = state.get("original_request", "")
    plan = list(state.get("plan", []) or [])
    dependency_graph = dict(state.get("dependency_graph", {}))
    target_pillar_id = state.get("target_pillar_id")
    expansion_signals = state.get("expansion_signals", [])
    max_depth = state.get("max_depth", 3)

    # 1. Handle JIT Micro Expansion (Targeted) or Legacy Expansion Signals
    target_task = None
    depth = 0
    if target_pillar_id:
        target_task = next((t for t in plan if t["task_id"] == target_pillar_id), None)
        depth = target_task.get("depth", 0) if target_task else 0
    elif expansion_signals:
        sig = expansion_signals[0]
        target_task = {"task_id": sig["parent_id"], "description": sig["description"]}
        depth = sig["depth"]
        expansion_signals = expansion_signals[1:]

    if target_task:
        if depth >= max_depth:
             logger.warning(f"Reaching max planning depth ({max_depth}) for {target_task['task_id']}")
             if target_pillar_id:
                 for t in plan:
                     if t["task_id"] == target_pillar_id:
                         t["is_expanded"] = True
             return {"plan": plan, "target_pillar_id": None, "expansion_signals": expansion_signals}

        task_manager.update_task(execution_id, status="running", message=f"Expanding pillar: {target_task['task_id']}...")
        task_manager.add_aer_entry(
            execution_id,
            intent=f"Decompose pillar '{target_task['task_id']}' into atomic steps",
            observation=f"Parent Description: {target_task['description'][:100]}...",
            nodeId="planner"
        )
        mode = "MICRO_EXPANSION"
        user_prompt = f"Objective: {target_task['description']}\n\nDecompose this specifically into 3-5 sub-tasks or sub-pillars."
    else:
        task_manager.update_task(execution_id, status="running", message="Generating initial strategy...")
        task_manager.add_event(execution_id, "node_started", {"nodeId": "planner", "nodeName": "Hierarchical Planner"})
        task_manager.add_v2_telemetry(execution_id, "planner", {
            "status": "thinking",
            "hex_heartbeat": "0x4F2A",
            "message": "Initializing global strategy..."
        })
        task_manager.add_aer_entry(
            execution_id,
            intent="Generate high-level strategic pillars",
            observation=f"Request: {request[:100]}...",
            nodeId="planner"
        )
        mode = "MACRO_STRATEGY"
        user_prompt = f"Generate a high-level strategic plan for:\n\n{request}"

    # Optimization: Bypass Macro Strategy if plan is already present and approved (PBR-001 §1.2)
    if mode == "MACRO_STRATEGY" and state.get("plan_approved") and state.get("plan"):
        logger.info(f"Planner: Bypassing macro strategy, plan already approved for {execution_id}")
        return {
            "status": "scheduled", 
            "active_task_pool": state["plan"],
            "target_pillar_id": None
        }

    available_skills = discover_skills(workspace_id)
    skills_context = "\n".join([f"- {s['id']}: {s.get('description', 'No description')}" for s in available_skills])
    
    system_prompt = f"""You are a Hierarchical Task Planner for the Benny Swarm.
MODE: {mode}

Rules:
1. Break complexity down. Use `is_pillar: true` for high-level workstreams that need further decomposition later.
2. Use `is_pillar: false` for atomic tasks that can be executed directly by tools.
3. OUTPUT STRICT JSON.

OUTPUT FORMAT:
{{
    "tasks": [
        {{
            "task_id": "unique_string", 
            "description": "Clear description", 
            "is_pillar": true|false,
            "skill_hint": "skill_id_if_atomic_or_null",
            "dependencies": ["parent_task_id_if_nested"],
            "complexity": "high|medium|low"
        }}
    ]
}}
"""

    max_retries = 2
    response_text = ""
    for attempt in range(max_retries):
        try:
            model_id = state.get("model") or "local_lemonade"
            print(f"DEBUG: Planner calling call_model with model_id='{model_id}'")
            response_text = await call_model(
                model=model_id,
                messages=[
                    {"role": "system", "content": system_prompt + f"\n\nRef: workspace:{workspace_id}"},
                    {"role": "user", "content": user_prompt}
                ],
                temperature=0.2,
                max_tokens=2000,
                run_id=execution_id
            )
            
            parsed, thinking = parse_json_safe(response_text)
            tasks_data = parsed.get("tasks", [])
            if not tasks_data:
                 raise ValueError("No tasks generated")

            new_tasks = []
            for t in tasks_data:
                prefix = f"{target_task['task_id']}." if target_task else ""
                raw_tid = str(t.get("task_id", str(uuid.uuid4())[:4]))
                tid = f"{prefix}{raw_tid}" if not raw_tid.startswith(prefix) else raw_tid
                
                new_tasks.append(TaskItem(
                    task_id=tid,
                    description=t.get("description", ""),
                    status="pending",
                    skill_hint=t.get("skill_hint"),
                    assigned_skills=[],
                    parent_id=target_task["task_id"] if target_task else None,
                    depth=depth + 1,
                    wave=0,
                    dependencies=t.get("dependencies", []),
                    files_touched=[],
                    complexity=t.get("complexity", "medium"),
                    assigned_model=None,
                    estimated_tokens=None,
                    is_pillar=t.get("is_pillar", False),
                    is_expanded=False
                ))
            
            updated_plan = list(plan)
            for nt in new_tasks:
                if not any(et["task_id"] == nt["task_id"] for et in updated_plan):
                    updated_plan.append(nt)
                    dependency_graph[nt["task_id"]] = nt["dependencies"]

            if target_pillar_id:
                for t in updated_plan:
                    if t["task_id"] == target_pillar_id:
                        t["is_expanded"] = True
            
            task_manager.add_event(execution_id, "node_completed", {"nodeId": "planner", "mode": mode, "count": len(new_tasks)})
            return {
                "plan": updated_plan,
                "active_task_pool": updated_plan,
                "dependency_graph": dependency_graph,
                "target_pillar_id": None, 
                "expansion_signals": expansion_signals,
                "status": "planning",
                "workspace": workspace_id,
                "revision_count": state.get("revision_count", 0) + 1
            }
        except Exception as e:
            logger.warning("Planner failure (attempt %d): %s", attempt+1, e)
            if attempt == max_retries - 1:
                diag_dir = get_workspace_path(workspace_id, f"runs/{execution_id}/diagnostics")
                diag_dir.mkdir(parents=True, exist_ok=True)
                (diag_dir / "failed_planner_response.txt").write_text(f"Error: {str(e)}\n\n{response_text}")
                return {"status": "failed", "errors": [str(e)]}
    return {"status": "failed", "errors": ["Planner retry loop exhausted"]}



# =============================================================================
# NODE: WAVE SCHEDULER
# =============================================================================

def wave_scheduler_node(state: SwarmState) -> Dict[str, Any]:
    """
    Compute execution waves from the dependency graph.
    Validates no circular dependencies and resolves file conflicts.
    """
    plan = state.get("plan", [])
    dependency_graph = state.get("dependency_graph", {})
    execution_id = state.get("execution_id", "")
    
    if not plan:
        error_msg = "No plan to schedule"
        task_manager.update_task(execution_id, status="failed", message=error_msg)
        return {"status": "failed", "errors": [error_msg]}
    
    task_manager.update_task(execution_id, message=f"Scheduling {len(plan)} tasks into waves...")
    task_manager.add_event(execution_id, "node_started", {"nodeId": "wave_scheduler", "nodeName": "Wave Scheduler"})
    
    try:
        # Step 1: Compute waves from dependencies
        waves = compute_waves(plan, dependency_graph)
        
        # Step 2: Check for file conflicts within each wave
        file_assignments = {
            t["task_id"]: t.get("files_touched", []) for t in plan
        }
        waves = resolve_conflicts(waves, file_assignments)
        
        # Step 3: Update task wave assignments
        task_wave_map = {}
        for wave_idx, wave in enumerate(waves):
            for task_id in wave:
                task_wave_map[task_id] = wave_idx
        
        updated_plan = []
        for task in plan:
            task_copy = dict(task)
            task_copy["wave"] = task_wave_map.get(task["task_id"], 0)
            updated_plan.append(task_copy)
        
        # Step 4: Generate ASCII DAG
        ascii_dag = generate_ascii_dag(updated_plan, dependency_graph, waves)
        
        # Step 5: Assign models based on task complexity and keywords
        model_assignments = assign_models(updated_plan, MODEL_REGISTRY, state.get("model"))
        for task in updated_plan:
            if task["task_id"] in model_assignments:
                task["assigned_model"] = model_assignments[task["task_id"]]
        
        # Step 6: Find first incomplete wave (for JIT re-scheduling)
        first_incomplete = 0
        for i, wave in enumerate(waves):
            wave_tasks = [t for t in updated_plan if t["task_id"] in wave]
            if any(t.get("status") == "pending" for t in wave_tasks):
                first_incomplete = i
                break

        # Step 7: Topology Registration for V2
        topology = {
            "waves": waves,
            "nodes": [{"id": t["task_id"], "is_pillar": t.get("is_pillar")} for t in updated_plan],
            "edges": [{"source": src, "target": target} for target, srcs in dependency_graph.items() for src in srcs]
        }
        task_manager.update_task_topology(execution_id, topology)

        task_manager.add_event(execution_id, "node_completed", {"nodeId": "wave_scheduler", "output": waves})
        
        return {
            "plan": updated_plan,
            "waves": waves,
            "current_wave": first_incomplete,
            "ascii_dag": ascii_dag,
            "status": "scheduled",
        }
    
    except CircularDependencyError as e:
        return {
            "status": "failed",
            "errors": [f"Circular dependency: {str(e)}"],
        }


# =============================================================================
# NODE: ORCHESTRATOR (Command Pattern)
# =============================================================================

def orchestrator_node(state: SwarmState) -> Command:
    """
    Reviews current wave for unexpanded pillars.
    If a pillar is found in the current wave and not expanded, routes to planner for Micro Expansion.
    Otherwise, routes to dispatcher for execution.
    """
    plan = state.get("plan", [])
    waves = state.get("waves", [])
    current_wave_idx = state.get("current_wave", 0)
    execution_id = state.get("execution_id", "")
    
    if not plan:
        return Command(update={"status": "failed", "errors": ["No plan generated"]}, goto=END)
    
    if not waves:
        # If no waves but we have a plan, it might be the initial skeleton.
        # Check if first level has pillars.
        pillars = [t for t in plan if t.get("is_pillar") and not t.get("is_expanded")]
        if pillars:
             # Route to expand the first available pillar
             return Command(
                 update={"target_pillar_id": pillars[0]["task_id"], "status": "planning"},
                 goto="planner"
             )
        return Command(update={"status": "failed", "errors": ["No waves computed and no pillars to expand"]}, goto=END)
    
    # Check current wave for pillars
    if current_wave_idx < len(waves):
        current_wave_ids = waves[current_wave_idx]
        current_wave_tasks = [t for t in plan if t["task_id"] in current_wave_ids]
        
        # JIT Expansion: Find FIRST unexpanded pillar in this wave
        for task in current_wave_tasks:
            if task.get("is_pillar") and not task.get("is_expanded"):
                logger.info(f"Orchestrator: Routing JIT expansion for pillar {task['task_id']}")
                return Command(
                    update={"target_pillar_id": task["task_id"], "status": "planning"},
                    goto="planner"
                )
    
    return Command(
        update={"plan_approved": True, "status": "executing"},
        goto="dispatcher"
    )



# =============================================================================
# NODE: DISPATCHER (Fan-Out via Send)
# =============================================================================

def dispatcher_node(state: SwarmState) -> Dict[str, Any]:
    """ Entry point for the current wave's execution. """
    return {"status": "executing"}


def dispatch_tasks(state: SwarmState) -> List[Send]:
    """
    Dynamic router for fan-out tasks.
    Used in conditional edges to spin up parallel executors.
    """
    waves = state.get("waves", [])
    current_wave = state.get("current_wave", 0)
    plan = state.get("plan", [])
    execution_id = state.get("execution_id", "")
    
    if current_wave >= len(waves):
        return []  # Should not happen as context_handover guards this
    
    current_wave_task_ids = set(waves[current_wave])
    wave_tasks = [t for t in plan if t["task_id"] in current_wave_task_ids]
    
    sends = []
    for task in wave_tasks:
        # Skip pillars - they are handled by the Orchestrator -> Planner JIT loop
        if task.get("is_pillar"):
            continue
            
        sends.append(Send("executor", {
            "task": task,
            "execution_id": execution_id,
            "workspace": state.get("workspace", "default"),
            "model": task.get("assigned_model") or state.get("model", "ollama/llama3.2"),
            "context_handover": state.get("context_handover", {}),
        }))
    
    return sends


# =============================================================================
# NODE: EXECUTOR (Code Execution Pattern)
# =============================================================================

async def executor_node(state: Dict[str, Any]) -> Dict[str, Any]:
    """
    Executor node - executes a single task.
    Implements Code Execution pattern: generates executable approach.
    """
    task: TaskItem = state.get("task", {})
    task_id = task.get("task_id", "unknown")
    description = task.get("description", "")
    skill_hint = task.get("skill_hint")
    model = state.get("model", "ollama/llama3.2")
    workspace_id = state.get("workspace", "default")
    execution_id = state.get("execution_id")
    
    # Update Task Manager and Event Bus
    task_manager.add_event(execution_id, "node_started", {"nodeId": "executor", "nodeName": f"Executor: Task {task_id}"})
    task_manager.add_v2_telemetry(execution_id, f"executor_{task_id}", {
        "status": "running",
        "task_id": task_id,
        "model": model,
        "message": f"Compiling approach for {task_id}..."
    })
    
    task_manager.add_aer_entry(
        execution_id,
        intent=f"Executing task: {task_id}",
        observation=f"Description: {description[:100]}... [Model: {model}]",
        nodeId="executor"
    )
    
    start_time = datetime.now()
    
    try:
        # Check for skill to use
        skill_content = None
        workspace_id = state.get("workspace", "default")
        if skill_hint:
            skill_obj = registry.get_skill_by_id(skill_hint, workspace_id)
            if skill_obj:
                skill_content = skill_obj.content

        # NEW: Least Skills Security
        assigned_skills = list(task.get("assigned_skills", []))
        if skill_hint and skill_hint not in assigned_skills:
            assigned_skills.append(skill_hint)
        
        manifest = create_ephemeral_manifest(execution_id, assigned_skills)
        register_manifest(manifest)

        # DETERMINISTIC BYPASS — skip LLM entirely for manifest-declared atomic tasks
        if task.get("deterministic") and skill_hint:
            logger.info("[DETERMINISTIC] Bypassing LLM for task %s using skill %s", task_id, skill_hint)
            skill_args = task.get("skill_args") or {}
            try:
                skill_result = await registry.execute_skill(
                    skill_hint, 
                    workspace_id, 
                    agent_id=execution_id, 
                    **skill_args
                )
                execution_time_ms = int((datetime.now() - start_time).total_seconds() * 1000)
                task_manager.add_event(execution_id, "node_completed", {
                    "nodeId": "executor",
                    "task_id": task_id,
                    "mode": "deterministic",
                    "execution_time_ms": execution_time_ms,
                })
                return {
                    "partial_results": [{
                        "task_id": task_id,
                        "content": skill_result,
                        "error": None,
                        "status": "completed",
                        "wave": task.get("wave", 0),
                        "execution_time_ms": execution_time_ms,
                    }]
                }
            except Exception as se:
                logger.error("Deterministic skill execution failed for %s: %s", task_id, se)
                return {
                    "partial_results": [{
                        "task_id": task_id,
                        "content": None,
                        "error": str(se),
                        "status": "failed",
                        "wave": task.get("wave", 0),
                        "execution_time_ms": int((datetime.now() - start_time).total_seconds() * 1000),
                    }],
                    "errors": [str(se)],
                }
        
        # Build tool schemas for LLM
        assigned_skills = list(task.get("assigned_skills", []))
        if skill_hint and skill_hint not in assigned_skills:
            assigned_skills.append(skill_hint)
            
        tools = None
        if assigned_skills:
            # We map assigned_skills (Markdown skill stems) to tools
            # In Phase 7.2, we assume skill IDs match the stems
            tool_schemas = registry.get_tool_schemas(assigned_skills, state.get("workspace", "default"))
            if tool_schemas:
                tools = tool_schemas

        # Build execution prompt
        if skill_content:
            system_prompt = f"""You are executing a task using a predefined skill.

SKILL INSTRUCTIONS:
{skill_content}

Execute the task following these skill guidelines. Be thorough and comprehensive."""
        else:
            system_prompt = """You are a focused task executor. Complete the given task thoroughly.
Write comprehensive, well-structured content. Be specific and detailed.
If the task requires research or data you don't have, clearly state that the information is missing.
CRITICAL: Do NOT hallucinate or use external general knowledge for specific workspace reports. If tools return no data, report 'No data found'.

DYNAMIC EXPANSION:
If you identify a complex sub-pillar that requires dedicated research or separate execution, 
you can request a sub-swarm by including [[EXPAND: description of sub-task]] in your output.
Do this sparingly and only for significant knowledge gaps."""

        # Add context handover from previous waves
        context_handover = state.get("context_handover", {})
        if context_handover:
            handover_summary = "\n".join([f"- {k}: {v}" for k, v in context_handover.items()])
            system_prompt += f"\n\nCONTEXT FROM PREVIOUS WAVES:\n{handover_summary}"

        # Standardized workspace reference for Operating Manual augmentation
        system_prompt += f"\n\nRef: workspace:{workspace_id}"

        messages = [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": f"Execute this task:\n\n{description}"}
        ]
        
        # Tool-calling loop
        max_steps = 5
        current_step = 0
        executed_tools = []
        final_content = ""
        while current_step < max_steps:
            current_step += 1

            # LOCAL-FIRST DISPATCH: check if this is a local model and short-circuit
            # to avoid LiteLLM (which requires API keys for cloud providers).
            from benny.core.local_executor import resolve_executor as _resolve_executor
            _local_exec = _resolve_executor(model)

            if _local_exec:
                # Local model path: call executor directly, wrap result as a fake response object
                _sys_msg = None
                _user_msg = ""
                for _m in messages:
                    if isinstance(_m, dict):
                        if _m.get("role") == "system":
                            _sys_msg = _m.get("content")
                        elif _m.get("role") == "user":
                            _user_msg = _m.get("content", "")
                    else:
                        # LangChain message object
                        if getattr(_m, "type", None) == "system":
                            _sys_msg = _m.content
                        elif getattr(_m, "type", None) in ("human", "user"):
                            _user_msg = _m.content

                _raw_text = await _local_exec.generate(
                    prompt=_user_msg,
                    system=_sys_msg,
                    temperature=0.7,
                    max_tokens=3000,
                    run_id=execution_id,
                )

                # Extract reasoning if present
                final_content, thinking = extract_reasoning(_raw_text)
                if thinking:
                    task_manager.add_aer_entry(
                        execution_id,
                        intent=f"Executing task: {task_id}",
                        observation="Reasoning step detected during execution",
                        inference=thinking,
                        nodeId="executor",
                    )

                # Local models don't support tool_calls in this path; break the loop
                break

            else:
                # Cloud / LiteLLM path
                model_cfg = get_model_config(model)
                litellm_model = normalize_model_string(model)

                # Use call_model for the actual inference to benefit from resolution/local bypass
                # but we still want the raw response if we want to handle tools here.
                # WAIT: call_model returns a string. If we want tools, we need it to return a response or handle tools.
                
                # For now, let's just make call_model return the final string and handle tools inside it if possible.
                # BUT executor_node wants to log each tool call.
                
                response_content = await call_model(
                    model=model,
                    messages=messages,
                    temperature=0.7,
                    max_tokens=3000,
                    run_id=execution_id,
                    authorized_tools=assigned_skills
                )
                
                # Since call_model currently returns a string, we'll assume it handled everything.
                # We'll break the loop here.
                final_content = response_content
                break

                # Robust content/message extraction (cloud/LiteLLM path)
                if hasattr(response, "choices") and len(response.choices) > 0:
                    message = response.choices[0].message
                elif isinstance(response, dict) and "choices" in response and len(response["choices"]) > 0:
                    choice = response["choices"][0]
                    if isinstance(choice, dict):
                        message = choice.get("message")
                    else:
                        message = choice.message
                else:
                    logger.warning(f"Swarm executor: Response missing 'choices' block from {model}")
                    from langchain_core.messages import AIMessage
                    message = AIMessage(content=str(response))

                messages.append(message)

                if hasattr(message, "tool_calls") and message.tool_calls:
                    workspace_path = get_workspace_path(workspace_id)
                    pbr_threshold = state.get("pbr_threshold_tokens") or DEFAULT_PBR_THRESHOLD_TOKENS
                    for tc in message.tool_calls:
                        func_name = tc.function.name
                        call_id = tc.id
                        try:
                            args = json.loads(tc.function.arguments)
                        except Exception:
                            args = {}

                        # AOS-F7: resolve any artifact:// URIs in tool args before dispatch
                        args = resolve_uris_in_args(args, workspace_path=workspace_path)

                        result_str = await registry.execute_skill(
                            func_name,
                            workspace_id,
                            agent_id=execution_id,
                            **args
                        )

                        # AOS-F6: auto-promote large tool outputs above threshold
                        promoted = maybe_promote(
                            result_str,
                            workspace_path=workspace_path,
                            threshold_tokens=pbr_threshold,
                            task_id=task_id,
                        )
                        content_for_llm = (
                            json.dumps(promoted) if isinstance(promoted, dict) else promoted
                        )

                        executed_tools.append({"name": func_name, "args": args})
                        task_manager.add_tool_event(execution_id, func_name, args, result_str, nodeId="executor")
                        messages.append({
                            "role": "tool",
                            "tool_call_id": call_id,
                            "name": func_name,
                            "content": content_for_llm
                        })
                    continue
                else:
                    final_content = message.content or ""
                    break

        execution_time = int((datetime.now() - start_time).total_seconds() * 1000)
        
        task_manager.add_event(execution_id, "node_completed", {"nodeId": "executor", "output": final_content})
        
        return {
            "partial_results": [PartialResult(
                task_id=task_id,
                content=final_content,
                error=None,
                execution_time_ms=execution_time
            )]
        }
        
    except Exception as e:
        execution_time = int((datetime.now() - start_time).total_seconds() * 1000)
        task_manager.add_event(execution_id, "node_error", {"nodeId": "executor", "error": str(e)})
        return {
            "partial_results": [PartialResult(
                task_id=task_id,
                content=None,
                error=str(e),
                execution_time_ms=execution_time
            )]
        }


# =============================================================================
# NODE: EXPANSION MONITOR
# =============================================================================

async def expansion_monitor_node(state: SwarmState) -> Dict[str, Any]:
    """Inspects executor results for [[EXPAND]] signals."""
    expansion_signals = []
    results = state.get("partial_results", [])
    plan = state.get("plan", []) or []
    
    import re
    # Match [[EXPAND: description]]
    expand_pattern = re.compile(r"\[\[EXPAND:(.*?)\]\]", re.DOTALL)
    
    for result in results:
        content = result.get("content", "")
        if not content:
            continue
            
        matches = expand_pattern.findall(content)
        if matches:
            parent_task = next((t for t in plan if t["task_id"] == result["task_id"]), None)
            if parent_task:
                current_depth = parent_task.get("depth", 0)
                if current_depth < 2:
                    for desc in matches:
                        expansion_signals.append({
                            "parent_id": result["task_id"],
                            "description": desc.strip(),
                            "depth": current_depth
                        })
                else:
                    logger.warning(f"Task {result['task_id']} reached recursion limit (depth {current_depth})")
                
    return {"expansion_signals": expansion_signals}


# =============================================================================
# NODE: AGGREGATOR (Kludge Pattern)
# =============================================================================

def aggregator_node(state: SwarmState) -> Dict[str, Any]:
    """
    Aggregator node - combines all executor results into final document.
    """
    wave_results = state.get("wave_results", {})
    plan = state.get("plan", [])
    execution_id = state.get("execution_id", "")
    workspace = state.get("workspace", "default")
    
    # Flatten all results from all waves
    all_results = []
    for wave_idx_str in wave_results:
        all_results.extend(wave_results[wave_idx_str])
    
    # Separate successes and failures
    successful = [r for r in all_results if r.get("content")]
    failed = [r for r in all_results if r.get("error")]
    
    # Sort results by original plan order for consistency
    task_order = {t["task_id"]: i for i, t in enumerate(plan)} if plan else {}
    
    # Group results by parent_id for hierarchical reporting
    results_by_parent = {None: []}
    for result in successful:
        task = next((t for t in plan if t["task_id"] == result["task_id"]), None)
        parent_id = task.get("parent_id") if task else None
        if parent_id not in results_by_parent:
            results_by_parent[parent_id] = []
        results_by_parent[parent_id].append(result)
    
    # Build sections hierarchically
    sections = []
    
    # Start with root tasks (parent_id is None)
    root_results = results_by_parent.get(None, [])
    root_results.sort(key=lambda r: task_order.get(r["task_id"], 999))
    
    for result in root_results:
        task = next((t for t in plan if t["task_id"] == result["task_id"]), None)
        task_desc = task["description"] if task else f"Task {result['task_id']}"
        sections.append(f"## {task_desc}\n\n{result['content']}")
        
        # If this task was a pillar (even if executed, though usually skipped), check for children
        # OR if it was a pillar and we want to list its children under it
        # Actually, if we follow the parent_id chain:
        curr_id = result["task_id"]
        if curr_id in results_by_parent:
            for sub_res in results_by_parent[curr_id]:
                 sub_task = next((t for t in plan if t["task_id"] == sub_res["task_id"]), None)
                 sub_desc = sub_task["description"] if sub_task else f"Sub-task {sub_res['task_id']}"
                 sections.append(f"### {sub_desc}\n\n{sub_res['content']}")

    # Handle orphans or pillars where children had results but parent didn't have a 'result' slot
    # (Pillars are typically skipped by dispatcher, so they don't have a result in 'successful')
    for parent_id, children in results_by_parent.items():
        if parent_id is None: continue
        # If the parent itself didn't have a result, we still want to show its children
        parent_has_result = any(r["task_id"] == parent_id for r in successful)
        if not parent_has_result:
             parent_task = next((t for t in plan if t["task_id"] == parent_id), None)
             parent_desc = parent_task["description"] if parent_task else f"Pillar {parent_id}"
             sections.append(f"## {parent_desc}")
             for child in children:
                 child_task = next((t for t in plan if t["task_id"] == child["task_id"]), None)
                 child_desc = child_task["description"] if child_task else f"Task {child['task_id']}"
                 sections.append(f"### {child_desc}\n\n{child['content']}")
    
    # Build final document
    document_parts = [
        f"# Generated Document",
        f"*Execution ID: {execution_id}*",
        f"*Generated at: {datetime.now().isoformat()}*",
        "",
        "---",
        ""
    ]
    document_parts.extend(sections)
    
    # Handle failures (graceful degradation)
    status = "completed"
    if failed:
        if successful:
            status = "partial_success"
            document_parts.append("\n---\n")
            document_parts.append("## ⚠️ Incomplete Sections\n")
            document_parts.append(f"*{len(failed)} of {len(all_results)} tasks failed*\n")
            for result in failed:
                task = next((t for t in plan if t["task_id"] == result["task_id"]), None)
                task_desc = task["description"] if task else f"Task {result['task_id']}"
                document_parts.append(f"- **{task_desc}**: {result['error']}")
        else:
            status = "failed"
            return {
                "status": "failed",
                "errors": [f"All {len(failed)} tasks failed"],
                "final_document": None
            }
    
    final_document = "\n".join(document_parts)
    
    # Save artifact
    # Use output filename from config if defined, or default to execution_id
    output_files_cfg = state.get("output_files", [])
    if output_files_cfg:
        artifact_filename = output_files_cfg[0] # Take first defined output
    else:
        artifact_filename = f"{execution_id}_swarm_output.md"

    # NORMALIZE: Save to reports directory
    reports_path = get_workspace_path(workspace, "reports")
    reports_path.mkdir(parents=True, exist_ok=True)
    artifact_path = reports_path / artifact_filename
    artifact_path.parent.mkdir(parents=True, exist_ok=True)
    artifact_path.write_text(final_document, encoding="utf-8")
    
    # Update Task Manager
    task_manager.update_task(
        execution_id, 
        status="completed", 
        progress=100, 
        message=f"Swarm execution complete. Report saved to {artifact_filename}."
    )
    
    # Record output in state
    if artifact_filename not in output_files_cfg:
        output_files_cfg.append(artifact_filename)
    
    # Generate governance URL
    governance_url = get_governance_url(execution_id)
    
    task_manager.add_event(execution_id, "workflow_completed", {"artifact_path": str(artifact_path)})
    
    return {
        "final_document": final_document,
        "artifact_path": str(artifact_path),
        "output_files": output_files_cfg,
        "governance_url": governance_url,
        "status": status
    }


# =============================================================================
# NODE: CONTEXT HANDOVER
# =============================================================================

async def context_handover_node(state: SwarmState) -> Dict[str, Any]:
    """
    After a wave completes, summarize the delta state for the next wave.
    Trims full outputs to maintain context window budget.
    """
    partial_results = state.get("partial_results", [])
    current_waveIdx = state.get("current_wave", 0)
    waves = state.get("waves", [])
    plan = state.get("plan", [])
    limit = state.get("handover_summary_limit", 500)
    
    # Collect results from the current wave
    current_wave_task_ids = set(waves[current_waveIdx]) if current_waveIdx < len(waves) else set()
    wave_results_list = [r for r in partial_results if r.get("task_id") in current_wave_task_ids]
    
    # Build handover summary
    handover = dict(state.get("context_handover", {}))
    for result in wave_results_list:
        if result.get("content"):
            # Trim to prevent context bloat
            summary = result["content"][:limit]
            if len(result["content"]) > limit:
                summary += "... [truncated]"
            handover[f"task_{result['task_id']}"] = summary
    
    # Store wave results
    wave_results_map = dict(state.get("wave_results", {}))
    wave_results_map[str(current_waveIdx)] = wave_results_list
    
    # Advance to next wave
    next_wave = current_waveIdx + 1
    has_more_waves = next_wave < len(waves)
    
    # Reset partial_results for next wave dispatch
    return {
        "context_handover": handover,
        "wave_results": wave_results_map,
        "current_wave": next_wave,
        "partial_results": [], # Clear for next wave
        "status": "executing" if has_more_waves else "aggregating",
    }


# =============================================================================
# NODE: REVIEW
# =============================================================================

async def review_node(state: SwarmState) -> Dict[str, Any]:
    """
    Post-execution review pass.
    Validates execution quality and identifies gaps.
    """
    wave_results = state.get("wave_results", {})
    plan = state.get("plan", [])
    
    all_results = []
    for wr in wave_results.values():
        all_results.extend(wr)
        
    review_findings = []
    
    # Check 1: All tasks have results
    result_task_ids = {r["task_id"] for r in all_results}
    plan_task_ids = {t["task_id"] for t in plan}
    missing = plan_task_ids - result_task_ids
    if missing:
        review_findings.append({
            "type": "missing_results",
            "severity": "high",
            "message": f"Tasks without results: {', '.join(missing)}",
        })
    
    # Check 2: Error rate
    errors = [r for r in all_results if r.get("error")]
    if all_results:
        error_rate = len(errors) / len(all_results)
        if error_rate > 0:
            review_findings.append({
                "type": "error_rate",
                "severity": "high" if error_rate > 0.5 else "medium",
                "message": f"{len(errors)}/{len(all_results)} tasks failed ({error_rate:.0%} error rate)",
            })
    
    # Check 3: Dependency satisfaction
    dependency_graph = state.get("dependency_graph", {})
    for task in plan:
        deps = dependency_graph.get(task["task_id"], [])
        for dep in deps:
            dep_result = next((r for r in all_results if r["task_id"] == dep), None)
            if dep_result and dep_result.get("error"):
                review_findings.append({
                    "type": "broken_dependency",
                    "severity": "high",
                    "message": f"Task '{task['task_id']}' depends on failed task '{dep}'",
                })
    
    return {
        "review_pass_results": review_findings,
    }


# =============================================================================
# GRAPH BUILDER
# =============================================================================

def build_swarm_graph(checkpointer=None) -> StateGraph:
    """Build the wave-based Swarm workflow graph."""
    
    graph = StateGraph(SwarmState)
    
    # Add nodes
    graph.add_node("planner", planner_node)
    graph.add_node("wave_scheduler", wave_scheduler_node)
    graph.add_node("orchestrator", orchestrator_node)
    graph.add_node("dispatcher", dispatcher_node)
    graph.add_node("executor", executor_node)
    graph.add_node("context_handover", context_handover_node)
    graph.add_node("expansion_monitor", expansion_monitor_node)
    graph.add_node("review", review_node)
    graph.add_node("aggregator", aggregator_node)
    
    # Flow: START → planner → wave_scheduler → orchestrator
    graph.add_edge(START, "planner")
    graph.add_edge("planner", "wave_scheduler")
    graph.add_edge("wave_scheduler", "orchestrator")
    
    # orchestrator routes to dispatcher or planner via Command
    # dispatcher (dynamic fan-out) → executor (parallel tasks) → expansion_monitor (join)
    graph.add_conditional_edges("dispatcher", dispatch_tasks, ["executor"])
    graph.add_edge("executor", "expansion_monitor")
    graph.add_edge("expansion_monitor", "context_handover")
    
    # context_handover decides: more waves → dispatcher, OR done → review
    def after_wave(state: SwarmState) -> str:
        current_waveIdx = state.get("current_wave", 0)
        waves = state.get("waves", [])
        expansion_signals = state.get("expansion_signals", [])
        
        if expansion_signals:
            return "planner"
            
        if current_waveIdx < len(waves):
            return "dispatcher"
        return "review"
    
    graph.add_conditional_edges("context_handover", after_wave, {
        "planner": "planner",
        "dispatcher": "dispatcher",
        "review": "review",
    })
    
    graph.add_edge("review", "aggregator")
    graph.add_edge("aggregator", END)
    
    if checkpointer:
        return graph.compile(checkpointer=checkpointer)
    return graph.compile()


# =============================================================================
# EXECUTION HELPER
# =============================================================================

async def run_swarm_workflow(
    request: str,
    workspace: str = "default",
    model: str = "ollama/llama3.2",
    execution_id: Optional[str] = None,
    max_concurrency: Optional[int] = None,
    input_files: Optional[List[str]] = None,
    output_files: Optional[List[str]] = None,
    config: Optional[Dict[str, Any]] = None
) -> SwarmState:
    """
    Execute the swarm workflow with the given request.
    
    Args:
        request: The user's request to decompose and execute
        workspace: Workspace for file operations
        model: LLM model to use
        execution_id: Optional execution ID (auto-generated if not provided)
        max_concurrency: Override for SWARM_MAX_CONCURRENCY
    
    Returns:
        Final SwarmState with results
    """
    if execution_id is None:
        execution_id = str(uuid.uuid4())
    
    concurrency = max_concurrency or MAX_CONCURRENCY
    
    # Create checkpointer for state persistence
    checkpointer = MemorySaver()
    graph = build_swarm_graph(checkpointer)
    
    # Create initial state
    initial_state = create_swarm_state(
        execution_id=execution_id,
        workspace=workspace,
        original_request=request,
        model=model,
        max_concurrency=concurrency,
        input_files=input_files,
        output_files=output_files,
        config=config
    )
    
    # Track workflow start with declared inputs
    try:
        inputs = [f"data_in/{f}" for f in (input_files or [])]
        track_workflow_start(execution_id, "swarm", workspace, inputs=inputs)
        print(f"[LINEAGE] Started tracking workflow {execution_id} with inputs: {inputs}")
    except Exception as e:
        print(f"[LINEAGE] Failed to track start: {e}")
    
    # Execute graph with concurrency control
    thread_config = {
        "configurable": {"thread_id": execution_id},
        "max_concurrency": concurrency
    }
    
    start_time = datetime.now()
    try:
        result = await graph.ainvoke(initial_state, thread_config)
    except Exception as e:
        execution_time_ms = int((datetime.now() - start_time).total_seconds() * 1000)
        try:
            track_workflow_fail(execution_id, "swarm", workspace, str(e))
        except:
            pass
        raise e

    execution_time_ms = int((datetime.now() - start_time).total_seconds() * 1000)
    
    # Track workflow completion
    try:
        nodes_executed = ["planner", "wave_scheduler", "orchestrator", "dispatcher", "executor", "expansion_monitor", "context_handover", "review", "aggregator"]
        # NORMALIZE: Point to reports directory in lineage
        outputs = [f"reports/{os.path.basename(result.get('artifact_path', ''))}" if result.get('artifact_path') else f"reports/swarm_output_{execution_id}.md"]
        
        # Pass actual workspace and execution status to lineage
        track_workflow_complete(
            execution_id, 
            "swarm", 
            workspace, 
            nodes_executed, 
            execution_time_ms, 
            outputs=outputs,
            status=result.get("status", "completed")
        )
        print(f"[LINEAGE] Completed tracking workflow {execution_id} ({execution_time_ms}ms) with outputs: {outputs}")
    except Exception as e:
        print(f"[LINEAGE] Failed to track completion: {e}")
    
    return result

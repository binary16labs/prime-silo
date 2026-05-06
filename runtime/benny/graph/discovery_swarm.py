"""
Discovery Swarm — LangGraph workflow for parallel codebase exploration.
Specialized for architectural mapping and progressive discovery.
"""

from typing import Dict, List, Any, Optional, TypedDict
from langgraph.graph import StateGraph, START, END
from .graph_navigator import GraphNavigator
from ..core.task_manager import task_manager
from ..core.models import call_model
import json
import logging

logger = logging.getLogger(__name__)

class DiscoveryState(TypedDict):
    workspace: str
    nexus_id: str
    query: str
    provider: str
    model: str
    discovered_nodes: List[Dict[str, Any]]
    discovery_depth: int
    max_depth: int
    scout_waves: List[List[str]] # List of waves, each wave a list of file paths/symbols
    current_wave: int
    findings: List[str]
    status: str
    run_id: str
    answer: str

async def planner_node(state: DiscoveryState) -> Dict[str, Any]:
    """Uses LLM to decide which part of the graph to explore next based on the user's query."""
    workspace = state["workspace"]
    nexus_id = state["nexus_id"]
    query = state["query"]
    navigator = GraphNavigator(workspace, nexus_id)
    
    if state["current_wave"] == 0 and not state.get("scout_waves"):
        # Initial Wave: Get Blueprint
        task_manager.add_v2_telemetry(state["run_id"], "planner", {"message": "Mapping Layer 0 (Architecture)..."})
        blueprint = navigator.get_workspace_blueprint()
        
        if not blueprint:
             return {
                "findings": ["No grounded codebase nodes found in this Nexus. Blueprint is empty. Analysis aborted."],
                "status": "completed"
            }
            
        # Grounded Brain Call: Ask LLM which files are relevant to the query
        task_manager.add_v2_telemetry(state["run_id"], "planner", {"message": f"Reasoning about relevance for: '{query[:30]}...'"})
        
        blueprint_text = "\n".join([f"- {b['path']} (Deps: {len(b.get('dependencies', []))})" for b in blueprint[:20]])
        
        prompt = f"""You are an architectural strategist. Given the codebase blueprint below and the user's query, identify the TOP 5 files most relevant to answering the question.

USER QUERY: {query}

BLUEPRINT:
{blueprint_text}

OUTPUT: Return ONLY a JSON list of strings (file paths). Example: ["src/main.py", "api/server.py"]"""

        try:
            model_id = f"{state['provider']}/{state['model']}" if state['provider'] else state['model']
            messages = [{"role": "user", "content": prompt}]
            response = await call_model(model_id, messages, run_id=state.get("run_id"))
            
            # Extract JSON list (sometimes LLMs wrap in markdown)
            json_str = response.strip()
            if "```" in json_str:
                json_str = json_str.split("```")[1].replace("json", "").strip()
            
            scout_paths = json.loads(json_str)
            if not isinstance(scout_paths, list):
                scout_paths = [b['path'] for b in blueprint[:5]] # Fallback
        except Exception as e:
            logger.error(f"Planner reasoning failed: {e}")
            scout_paths = [b['path'] for b in blueprint[:5]] # Fallback
            
        task_manager.add_v2_telemetry(state["run_id"], "planner", {"message": f"Selecting {len(scout_paths)} key files for scouting."})
            
        return {
            "scout_waves": [scout_paths],
            "status": "exploring"
        }
    
    # If we already explored the waves we planned, move to synthesis
    if state["current_wave"] >= len(state.get("scout_waves", [])):
        return {"status": "synthesizing"}
    
    return {"status": "exploring"}

async def scout_node(state: DiscoveryState) -> Dict[str, Any]:
    """Executes GraphNavigator queries and uses LLM to summarize the findings."""
    workspace = state["workspace"]
    nexus_id = state["nexus_id"]
    run_id = state["run_id"]
    query = state["query"]
    navigator = GraphNavigator(workspace, nexus_id)
    
    waves = state.get("scout_waves", [])
    if state["current_wave"] >= len(waves):
        return {"status": "synthesizing"}
        
    wave_paths = waves[state["current_wave"]]
    
    new_findings = []
    discovered = []
    
    for path in wave_paths:
        task_manager.add_v2_telemetry(run_id, "scout", {"message": f"Peeking symbols in {path}", "layer": 1})
        details = navigator.explore_file(path)
        symbols = details.get("symbols", [])
        discovered.extend(symbols)
        
        # Grounded Brain Call: Summarize the file's purpose relative to the query
        symbol_list = ", ".join([s['name'] for s in symbols[:10]])
        prompt = f"""Briefly explain the purpose of the file '{path}' in the context of the query: '{query}'.
Symbols defined here: {symbol_list}
Keep it to 2-3 sentences."""
        
        try:
            model_id = f"{state['provider']}/{state['model']}" if state['provider'] else state['model']
            messages = [{"role": "user", "content": prompt}]
            summary = await call_model(model_id, messages, run_id=run_id)
            new_findings.append(f"**{path}**: {summary}")
        except Exception:
            new_findings.append(f"**{path}**: Contains {len(symbols)} symbols including {symbol_list}.")
        
    return {
        "discovered_nodes": state["discovered_nodes"] + discovered,
        "findings": state["findings"] + new_findings,
        "current_wave": state["current_wave"] + 1
    }

async def synthesize_node(state: DiscoveryState) -> Dict[str, Any]:
    """Final node that compiles all findings into a technical answer."""
    task_manager.add_v2_telemetry(state["run_id"], "synthesizer", {"message": "Finalizing architectural report..."})
    
    prompt = f"""You are a senior system architect. Synthesize a comprehensive answer to the user's query based on the codebase discovery findings below.

USER QUERY: {state['query']}

DISCOVERY FINDINGS:
{chr(10).join(state['findings'])}

INSTRUCTIONS:
- provide a clear, technical explanation.
- Mention specific files and patterns identified.
- If the findings don't fully answer the query, explain what was found and what remains unknown.
- use professional engineering tone.
"""

    try:
        model_id = f"{state['provider']}/{state['model']}" if state['provider'] else state['model']
        messages = [{"role": "user", "content": prompt}]
        answer = await call_model(model_id, messages, run_id=state.get("run_id"))
    except Exception as e:
        answer = f"I've explored the codebase but encountered an error during synthesis: {str(e)}\n\nFindings:\n" + "\n".join(state["findings"])

    return {
        "answer": answer,
        "status": "completed"
    }

def build_discovery_graph() -> StateGraph:
    graph = StateGraph(DiscoveryState)
    
    graph.add_node("planner", planner_node)
    graph.add_node("scout", scout_node)
    graph.add_node("synthesizer", synthesize_node)
    
    graph.add_edge(START, "planner")
    
    def route_discovery(state: DiscoveryState):
        if state["status"] == "synthesizing":
            return "synthesizer"
        if state["status"] == "completed":
            return END
        return "scout"
    
    graph.add_conditional_edges("planner", route_discovery)
    graph.add_edge("scout", "planner")
    graph.add_edge("synthesizer", END)
    
    return graph.compile()

async def run_discovery_swarm(workspace: str, nexus_id: str, query: str, run_id: str, provider: str = "ollama", model: str = ""):
    """Entry point for the Discovery Swarm."""
    workflow = build_discovery_graph()
    initial_state = {
        "workspace": workspace,
        "nexus_id": nexus_id,
        "query": query,
        "provider": provider,
        "model": model,
        "run_id": run_id,
        "discovered_nodes": [],
        "discovery_depth": 0,
        "max_depth": 2,
        "scout_waves": [],
        "current_wave": 0,
        "findings": [],
        "status": "starting",
        "answer": ""
    }
    
    result = await workflow.ainvoke(initial_state)
    # Ensure the final output matches what rag_routes expects
    return {
        "answer": result.get("answer", "No answer synthesized."),
        "findings": result.get("findings", []),
        "status": result.get("status", "completed"),
        "run_id": run_id
    }

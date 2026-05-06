"""
Benny Graph Workflow - LangGraph StateGraph implementation
Deterministic workflow execution with conditional routing and HITL checkpoints
"""

from __future__ import annotations

import logging
from typing import Annotated, Literal, TypedDict, Optional, Any
from langgraph.graph import StateGraph, START, END
from langgraph.graph.message import add_messages
from langgraph.checkpoint.memory import MemorySaver
from langchain_core.messages import BaseMessage, HumanMessage, AIMessage, SystemMessage
from litellm import completion
import json

logger = logging.getLogger(__name__)

from ..core.state import GraphState


# =============================================================================
# STATE DEFINITION
# =============================================================================

class WorkflowState(TypedDict):
    """Extended state for workflow execution"""
    messages: Annotated[list[BaseMessage], add_messages]
    context: dict[str, Any]
    workspace: str
    current_node: str
    tool_outputs: dict[str, Any]
    requires_approval: bool
    approved: Optional[bool]
    error: Optional[str]
    metadata: dict[str, Any]


# =============================================================================
# NODE FUNCTIONS
# =============================================================================

def process_input(state: WorkflowState) -> dict:
    """Process initial input and prepare context"""
    return {
        "current_node": "process_input",
        "context": {
            **state.get("context", {}),
            "processed": True
        }
    }


def call_llm(state: WorkflowState) -> dict:
    """Call LLM with current messages and context"""
    messages = state.get("messages", [])
    context = state.get("context", {})
    
    # Get model config (default to local Ollama)
    model = context.get("model", "ollama/llama3.2")
    
    # Build system message with context
    system_content = context.get("system_prompt", "You are a helpful AI assistant.")
    if context.get("workspace_context"):
        system_content += f"\n\nWorkspace context:\n{context['workspace_context']}"
    
    # Convert messages to LiteLLM format
    litellm_messages = [{"role": "system", "content": system_content}]
    for msg in messages:
        if isinstance(msg, HumanMessage):
            litellm_messages.append({"role": "user", "content": msg.content})
        elif isinstance(msg, AIMessage):
            litellm_messages.append({"role": "assistant", "content": msg.content})
    
    try:
        response = completion(
            model=model,
            messages=litellm_messages,
            temperature=context.get("temperature", 0.7),
            max_tokens=context.get("max_tokens", 2000)
        )
        
        ai_message = AIMessage(content=response.choices[0].message.content)
        
        return {
            "messages": [ai_message],
            "current_node": "call_llm",
            "metadata": {
                **state.get("metadata", {}),
                "model_used": model,
                "tokens_used": response.usage.total_tokens if response.usage else None
            }
        }
    except Exception as e:
        return {
            "error": str(e),
            "current_node": "call_llm"
        }


def execute_tool(state: WorkflowState) -> dict:
    """Execute a tool based on LLM output"""
    context = state.get("context", {})
    tool_name = context.get("pending_tool")
    tool_args = context.get("pending_tool_args", {})
    
    if not tool_name:
        return {"current_node": "execute_tool"}
    
    # Import tools dynamically
    from ..tools.knowledge import search_knowledge_workspace
    from ..tools.files import read_file, write_file
    from ..tools.data import extract_pdf_text, query_csv
    
    tool_map = {
        "search_knowledge_workspace": search_knowledge_workspace,
        "read_file": read_file,
        "write_file": write_file,
        "extract_pdf_text": extract_pdf_text,
        "query_csv": query_csv,
    }
    
    tool_fn = tool_map.get(tool_name)
    if not tool_fn:
        return {
            "error": f"Unknown tool: {tool_name}",
            "current_node": "execute_tool"
        }
    
    try:
        result = tool_fn(**tool_args)
        return {
            "tool_outputs": {
                **state.get("tool_outputs", {}),
                tool_name: result
            },
            "current_node": "execute_tool"
        }
    except Exception as e:
        return {
            "error": f"Tool execution failed: {str(e)}",
            "current_node": "execute_tool"
        }


def human_review(state: WorkflowState) -> dict:
    """Human-in-the-loop checkpoint - waits for approval"""
    return {
        "requires_approval": True,
        "current_node": "human_review"
    }


def format_output(state: WorkflowState) -> dict:
    """Format final output for response"""
    messages = state.get("messages", [])
    tool_outputs = state.get("tool_outputs", {})
    
    # Get last AI message
    last_ai_message = None
    for msg in reversed(messages):
        if isinstance(msg, AIMessage):
            last_ai_message = msg.content
            break
    
    return {
        "context": {
            **state.get("context", {}),
            "final_response": last_ai_message,
            "tool_results": tool_outputs
        },
        "current_node": "format_output"
    }


# =============================================================================
# ROUTING FUNCTIONS
# =============================================================================

def should_use_tool(state: WorkflowState) -> Literal["execute_tool", "human_review", "format_output"]:
    """Determine if tool execution is needed. Error-aware: routes to output on failure."""
    # If there was an error in the LLM call, skip tools and go to output
    if state.get("error"):
        logger.warning("Error detected in state, routing to format_output: %s", state["error"])
        return "format_output"

    context = state.get("context", {})
    
    if context.get("pending_tool"):
        return "execute_tool"
    elif context.get("requires_human_approval"):
        return "human_review"
    else:
        return "format_output"


def after_tool(state: WorkflowState) -> Literal["call_llm", "format_output"]:
    """After tool execution, decide next step"""
    if state.get("error"):
        return "format_output"
    
    # Continue LLM conversation with tool result
    context = state.get("context", {})
    if context.get("continue_after_tool", True):
        return "call_llm"
    return "format_output"


def after_review(state: WorkflowState) -> Literal["call_llm", "format_output"]:
    """After human review, decide next step"""
    if state.get("approved"):
        return "call_llm"
    return "format_output"


# =============================================================================
# GRAPH BUILDER
# =============================================================================

def build_workflow_graph(checkpointer=None) -> StateGraph:
    """Build the main workflow graph"""
    
    # Create graph with state schema
    graph = StateGraph(WorkflowState)
    
    # Add nodes
    graph.add_node("process_input", process_input)
    graph.add_node("call_llm", call_llm)
    graph.add_node("execute_tool", execute_tool)
    graph.add_node("human_review", human_review)
    graph.add_node("format_output", format_output)
    
    # Add edges
    graph.add_edge(START, "process_input")
    graph.add_edge("process_input", "call_llm")
    
    # Conditional routing after LLM
    graph.add_conditional_edges(
        "call_llm",
        should_use_tool,
        {
            "execute_tool": "execute_tool",
            "human_review": "human_review",
            "format_output": "format_output"
        }
    )
    
    # After tool execution
    graph.add_conditional_edges(
        "execute_tool",
        after_tool,
        {
            "call_llm": "call_llm",
            "format_output": "format_output"
        }
    )
    
    # After human review
    graph.add_conditional_edges(
        "human_review",
        after_review,
        {
            "call_llm": "call_llm",
            "format_output": "format_output"
        }
    )
    
    # End
    graph.add_edge("format_output", END)
    
    # Compile with checkpointer if provided
    if checkpointer:
        return graph.compile(checkpointer=checkpointer)
    return graph.compile()


def create_simple_chat_graph(checkpointer=None) -> StateGraph:
    """Create a simple chat graph without tools"""
    
    graph = StateGraph(WorkflowState)
    
    graph.add_node("call_llm", call_llm)
    graph.add_node("format_output", format_output)
    
    graph.add_edge(START, "call_llm")
    graph.add_edge("call_llm", "format_output")
    graph.add_edge("format_output", END)
    
    if checkpointer:
        return graph.compile(checkpointer=checkpointer)
    return graph.compile()


# =============================================================================
# EXECUTION HELPERS
# =============================================================================

async def run_workflow(
    messages: list[BaseMessage],
    workspace: str = "default",
    model: str = "ollama/llama3.2",
    config: Optional[dict] = None
) -> dict:
    """Run the workflow with given messages"""
    
    # Create checkpointer for state persistence
    checkpointer = MemorySaver()
    graph = build_workflow_graph(checkpointer)
    
    initial_state: WorkflowState = {
        "messages": messages,
        "context": {
            "model": model,
            **(config or {})
        },
        "workspace": workspace,
        "current_node": "",
        "tool_outputs": {},
        "requires_approval": False,
        "approved": None,
        "error": None,
        "metadata": {}
    }
    
    # Run the graph
    thread_config = {"configurable": {"thread_id": f"workflow-{workspace}"}}
    result = await graph.ainvoke(initial_state, thread_config)
    
    return result

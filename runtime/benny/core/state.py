"""
GraphState - Core state schema for all workflows
"""

from typing import TypedDict, Annotated, List, Optional, Any, Dict
from langchain_core.messages import BaseMessage
import operator


def add_messages(left: List[BaseMessage], right: List[BaseMessage]) -> List[BaseMessage]:
    """Reducer that appends new messages to existing list"""
    return left + right


def add_results(left: List[Dict], right: List[Dict]) -> List[Dict]:
    """Reducer that appends partial results from parallel executors"""
    return left + right


class GraphState(TypedDict):
    """
    Core state schema for all Benny workflows.
    
    Attributes:
        messages: Conversation history with reducer for appending
        context: Data references, configuration, runtime context
        artifacts: List of generated file paths
        errors: Error accumulator for debugging
        workspace_id: Active workspace for multi-tenant isolation
        trace_context: W3C traceparent for distributed tracing
        current_node: Currently executing node (for UI updates)
        execution_id: Unique ID for this workflow execution
    """
    messages: Annotated[List[BaseMessage], add_messages]
    context: dict
    artifacts: List[str]
    errors: List[str]
    workspace_id: str
    trace_context: dict
    current_node: Optional[str]
    execution_id: Optional[str]


# =============================================================================
# SWARM STATE - Extended state for parallel task execution
# =============================================================================

class TaskItem(TypedDict):
    """Individual task in the swarm plan"""
    task_id: str
    description: str
    status: str  # pending, running, completed, failed
    skill_hint: Optional[str]  # Suggested skill from benny/skills/
    assigned_skills: List[str]         # Specific MCP skills allowed for this task
    parent_id: Optional[str]           # Link to the task that spawned this sub-task
    depth: int                         # Recursive depth (0 = root)
    # === NEW FIELDS ABOVE ===
    wave: int                          # Wave assignment (0-indexed)
    dependencies: List[str]            # List of task_ids this task depends on
    assigned_model: Optional[str]      # Role-specific model
    files_touched: List[str]           # Files this task will read/write
    estimated_tokens: Optional[int]    # Estimated token cost
    complexity: Optional[str]          # high, medium, low
    is_pillar: bool                    # True if this is a high-level bucket needing expansion
    is_expanded: bool                  # True if this pillar has already been decomposed
    deterministic: bool                # True to bypass LLM — run skill_hint directly with skill_args
    skill_args: Dict[str, Any]         # Pre-defined arguments passed to the skill for deterministic tasks


class PartialResult(TypedDict):
    """Result from a single executor"""
    task_id: str
    content: Optional[str]
    error: Optional[str]
    execution_time_ms: int


class SwarmState(TypedDict):
    """
    Extended state for Swarm Planner workflow.
    Supports parallel execution with reducer-based result merging.
    
    Design Principles:
    - Assemblage: State as persistent memory for time-travel debugging
    - Bricolage: Planner looks for existing skills before LLM generation
    - Kludge: Aggregator handles partial failures gracefully
    """
    # Core identifiers
    execution_id: str
    workspace: str
    
    # Messages and context
    messages: Annotated[List[BaseMessage], add_messages]
    original_request: str
    
    # Planning
    plan: Optional[List[TaskItem]]
    plan_approved: bool
    revision_count: int  # Track replanning cycles
    
    # Execution - uses reducer for parallel writes
    partial_results: Annotated[List[PartialResult], operator.add]
    
    # Output
    final_document: Optional[str]
    artifact_path: Optional[str]
    
    # Governance
    governance_url: Optional[str]
    
    # Error handling
    errors: Annotated[List[str], operator.add]
    status: str  # pending, planning, executing, aggregating, completed, partial_success, failed
    
    # Configuration
    model: str
    max_concurrency: int
    input_files: List[str]                  # Declared inputs from YAML
    output_files: List[str]                 # Declared outputs from YAML
    config: Dict[str, Any]                  # Full config dictionary from YAML
    target_pillar_id: Optional[str]         # ID of the pillar currently being expanded (JIT)
    max_depth: int                          # Max recursion depth for planning

    # Recursive Expansion
    active_task_pool: List[TaskItem]              # All tasks (including dynamically added ones)
    expansion_signals: List[Dict[str, Any]]       # Requests for new sub-tasks
    # === NEW FIELDS ABOVE ===
    dependency_graph: Dict[str, List[str]]       # task_id → [dependency_task_ids]
    waves: List[List[str]]                        # Computed wave schedule: [[task_ids in wave 0], [wave 1], ...]
    current_wave: int                             # Index of currently executing wave
    wave_results: Dict[str, List[PartialResult]]  # Results grouped by wave index
    context_handover: Dict[str, Any]              # Accumulated state delta passed between waves
    review_pass_results: List[Dict[str, Any]]     # Findings from post-execution review
    ascii_dag: Optional[str]                      # ASCII visualization
    handover_summary_limit: int                   # Max chars per task result in handover


def create_swarm_state(
    execution_id: str,
    workspace: str = "default",
    original_request: str = "",
    model: str = None,  # Resolved model from LLM Manager
    max_concurrency: int = 1,
    handover_summary_limit: int = 500,
    input_files: Optional[List[str]] = None,
    output_files: Optional[List[str]] = None,
    config: Optional[Dict[str, Any]] = None,
    max_depth: int = 3
) -> SwarmState:
    """Create initial state for a new swarm workflow execution"""
    return SwarmState(
        execution_id=execution_id,
        workspace=workspace,
        messages=[],
        original_request=original_request,
        plan=None,
        plan_approved=False,
        revision_count=0,
        partial_results=[],
        final_document=None,
        artifact_path=None,
        governance_url=None,
        errors=[],
        status="pending",
        model=model,
        max_concurrency=max_concurrency,
        input_files=input_files or [],
        output_files=output_files or [],
        config=config or {},
        # === RECURSION DEFAULTS ===
        active_task_pool=[],
        expansion_signals=[],
        # === NEW DEFAULTS ===
        dependency_graph={},
        waves=[],
        current_wave=0,
        wave_results={},
        context_handover={},
        review_pass_results=[],
        ascii_dag=None,
        handover_summary_limit=handover_summary_limit,
        target_pillar_id=None,
        max_depth=max_depth
    )


def create_initial_state(
    workspace_id: str = "default",
    context: Optional[dict] = None,
    trace_context: Optional[dict] = None
) -> GraphState:
    """Create initial state for a new workflow execution"""
    return GraphState(
        messages=[],
        context=context or {},
        artifacts=[],
        errors=[],
        workspace_id=workspace_id,
        trace_context=trace_context or {},
        current_node=None,
        execution_id=None
    )


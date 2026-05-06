"""
Enhanced Execution Audit System - Detailed failure tracking for workflows and tasks
Captures node-level errors, stack traces, and execution context for debugging
"""

import json
import logging
import traceback
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, Any, Optional, List
from enum import Enum

from .audit import emit_governance_event, _get_workspace_path

logger = logging.getLogger(__name__)

class ExecutionPhase(Enum):
    """Execution phases for tracking workflow progress."""
    INITIALIZATION = "initialization"
    VALIDATION = "validation"
    EXECUTION = "execution"
    FINALIZATION = "finalization"
    COMPLETED = "completed"
    FAILED = "failed"

def emit_execution_failure(
    execution_id: str,
    workspace_id: str,
    phase: ExecutionPhase,
    error: Exception,
    node_id: Optional[str] = None,
    context: Dict[str, Any] = None
):
    """
    Emit detailed failure event with full context, stack trace, and error hierarchy.
    
    Args:
        execution_id: Unique execution identifier
        workspace_id: Workspace identifier
        phase: Execution phase where failure occurred
        error: The exception that was raised
        node_id: Optional node ID if failure is node-specific
        context: Additional context (inputs, outputs, state, etc.)
    """
    # Build exception chain
    exc_chain = []
    current_exc = error
    while current_exc is not None:
        exc_chain.append({
            "type": type(current_exc).__name__,
            "message": str(current_exc),
            "module": type(current_exc).__module__,
        })
        current_exc = current_exc.__cause__
    
    failure_event = {
        "execution_id": execution_id,
        "phase": phase.value,
        "node_id": node_id,
        "error": {
            "type": type(error).__name__,
            "message": str(error),
            "stack_trace": traceback.format_exc(),
            "exception_chain": exc_chain,
        },
        "context": context or {},
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }
    
    emit_governance_event(
        event_type="EXECUTION_FAILURE",
        data=failure_event,
        workspace_id=workspace_id,
        mirror=True
    )

def emit_node_execution_state(
    execution_id: str,
    workspace_id: str,
    node_id: str,
    status: str,  # "started", "completed", "failed"
    inputs: Dict[str, Any] = None,
    outputs: Dict[str, Any] = None,
    error: Optional[str] = None,
    duration_ms: float = 0
):
    """Emit detailed node execution state for traceability."""
    emit_governance_event(
        event_type="NODE_EXECUTION_STATE",
        data={
            "execution_id": execution_id,
            "node_id": node_id,
            "status": status,
            "inputs": inputs or {},
            "outputs": outputs or {},
            "error": error,
            "duration_ms": duration_ms,
            "timestamp": datetime.now(timezone.utc).isoformat(),
        },
        workspace_id=workspace_id,
        mirror=True
    )

def emit_execution_checkpoint(
    execution_id: str,
    workspace_id: str,
    checkpoint_name: str,
    data: Dict[str, Any]
):
    """Emit execution checkpoint for debugging workflow progression."""
    emit_governance_event(
        event_type="EXECUTION_CHECKPOINT",
        data={
            "execution_id": execution_id,
            "checkpoint": checkpoint_name,
            "data": data,
            "timestamp": datetime.now(timezone.utc).isoformat(),
        },
        workspace_id=workspace_id,
        mirror=True
    )

def retrieve_execution_audit(
    execution_id: str,
    workspace_id: str,
    include_nodes: bool = True,
    include_checkpoints: bool = True
) -> Dict[str, Any]:
    """
    Retrieve comprehensive audit trail for a specific execution.
    
    Returns audit events in chronological order with full error details.
    """
    audit_path = _get_workspace_path(workspace_id, "runs/audit.log")
    
    if not audit_path.exists():
        return {
            "execution_id": execution_id,
            "status": "not_found",
            "events": []
        }
    
    execution_events = {
        "failures": [],
        "node_states": [],
        "checkpoints": [],
        "all_events": [],
        "summary": {
            "total_events": 0,
            "failure_count": 0,
            "node_count": 0,
            "first_failure": None,
            "execution_phases": []
        }
    }
    
    try:
        with open(audit_path, 'r', encoding='utf-8') as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                
                try:
                    event = json.loads(line)
                    event_data = event.get("data", {})
                    event_exec_id = event_data.get("execution_id") or event_data.get("task_id")
                    
                    # Filter for this execution
                    if event_exec_id != execution_id:
                        continue
                    
                    execution_events["all_events"].append(event)
                    execution_events["summary"]["total_events"] += 1
                    
                    # Categorize by event type
                    event_type = event.get("event_type")
                    
                    if event_type == "EXECUTION_FAILURE":
                        execution_events["failures"].append(event)
                        execution_events["summary"]["failure_count"] += 1
                        if execution_events["summary"]["first_failure"] is None:
                            execution_events["summary"]["first_failure"] = event.get("timestamp")
                    
                    elif event_type == "NODE_EXECUTION_STATE":
                        execution_events["node_states"].append(event)
                        execution_events["summary"]["node_count"] += 1
                    
                    elif event_type == "EXECUTION_CHECKPOINT":
                        execution_events["checkpoints"].append(event)
                        cp_name = event_data.get("checkpoint")
                        if cp_name not in execution_events["summary"]["execution_phases"]:
                            execution_events["summary"]["execution_phases"].append(cp_name)
                    
                except json.JSONDecodeError:
                    logger.warning(f"Could not parse audit line: {line[:100]}")
                    continue
        
        # Compute execution status from events
        if execution_events["failures"]:
            execution_events["status"] = "failed"
            execution_events["first_error"] = {
                "phase": execution_events["failures"][0].get("data", {}).get("phase"),
                "message": execution_events["failures"][0].get("data", {}).get("error", {}).get("message"),
            }
        elif execution_events["all_events"]:
            # Check if final event shows completion
            last_event = execution_events["all_events"][-1]
            if "COMPLETE" in last_event.get("event_type", ""):
                execution_events["status"] = "completed"
            else:
                execution_events["status"] = "unknown"
        else:
            execution_events["status"] = "not_found"
        
        # Remove all_events if not requested
        if not (include_nodes and include_checkpoints):
            execution_events.pop("all_events", None)
        
        return execution_events
        
    except Exception as e:
        logger.error(f"Error retrieving execution audit: {e}")
        return {
            "execution_id": execution_id,
            "status": "error",
            "error": str(e),
            "events": []
        }

def get_failed_nodes(
    execution_id: str,
    workspace_id: str
) -> List[Dict[str, Any]]:
    """Extract all failed nodes from execution audit."""
    audit = retrieve_execution_audit(execution_id, workspace_id)
    failed_nodes = []
    
    for node_event in audit.get("node_states", []):
        if node_event.get("data", {}).get("status") == "failed":
            failed_nodes.append(node_event.get("data", {}))
    
    return failed_nodes

def generate_execution_report(
    execution_id: str,
    workspace_id: str
) -> str:
    """Generate human-readable execution failure report."""
    audit = retrieve_execution_audit(execution_id, workspace_id, include_nodes=True, include_checkpoints=True)
    
    report_lines = [
        "=" * 80,
        f"EXECUTION AUDIT REPORT - {execution_id}",
        "=" * 80,
        f"Status: {audit.get('status', 'unknown').upper()}",
        f"Workspace: {workspace_id}",
        f"Total Events: {audit['summary'].get('total_events', 0)}",
        f"Failures: {audit['summary'].get('failure_count', 0)}",
        "",
    ]
    
    if audit.get('first_error'):
        report_lines.extend([
            "FIRST FAILURE:",
            f"  Phase: {audit['first_error'].get('phase', 'unknown')}",
            f"  Message: {audit['first_error'].get('message', 'unknown')}",
            "",
        ])
    
    if audit.get('failures'):
        report_lines.extend([
            "DETAILED FAILURES:",
            "-" * 80,
        ])
        for failure in audit['failures']:
            error_data = failure.get("data", {})
            report_lines.extend([
                f"Timestamp: {error_data.get('timestamp')}",
                f"Phase: {error_data.get('phase')}",
                f"Node: {error_data.get('node_id', 'N/A')}",
                f"Error Type: {error_data.get('error', {}).get('type')}",
                f"Error Message: {error_data.get('error', {}).get('message')}",
                "Stack Trace:",
                error_data.get('error', {}).get('stack_trace', '  (not available)'),
                "-" * 80,
                "",
            ])
    
    if audit.get('node_states'):
        failed_nodes = [n for n in audit['node_states'] 
                       if n.get("data", {}).get("status") == "failed"]
        if failed_nodes:
            report_lines.extend([
                "FAILED NODES:",
                "-" * 80,
            ])
            for node in failed_nodes:
                node_data = node.get("data", {})
                report_lines.extend([
                    f"Node ID: {node_data.get('node_id')}",
                    f"Status: {node_data.get('status')}",
                    f"Duration: {node_data.get('duration_ms')}ms",
                    f"Error: {node_data.get('error', 'N/A')}",
                    "",
                ])
    
    return "\n".join(report_lines)

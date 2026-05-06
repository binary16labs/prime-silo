"""
Governance Routes - API endpoints for security manuals and audit integrity.
"""

from fastapi import APIRouter, HTTPException, Query, Body
from typing import List, Optional, Dict, Any
from pathlib import Path
import logging

from ..governance.audit import verify_audit_integrity, emit_security_event
from ..governance.execution_audit import (
    retrieve_execution_audit,
    get_failed_nodes,
    generate_execution_report
)
from ..governance.operating_manual import (
    get_agent_identity, 
    get_user_context, 
    get_operational_rules
)
from ..core.workspace import get_workspace_path

logger = logging.getLogger(__name__)

router = APIRouter()

@router.get("/integrity")
async def check_integrity(workspace: str = Query("global")):
    """Verify the integrity of the audit logs."""
    try:
        return verify_audit_integrity(workspace)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@router.get("/manuals/{workspace}")
async def get_manuals(workspace: str):
    """Retrieve the current operating manuals for a workspace."""
    try:
        identity = get_agent_identity(workspace)
        user_ctx = get_user_context(workspace)
        rules = get_operational_rules(workspace)
        
        return {
            "identity": identity,
            "user_context": user_ctx,
            "operational_rules": rules
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@router.post("/manuals/{workspace}/{filename}")
async def update_manual(workspace: str, filename: str, content: Dict[str, str] = Body(...)):
    """Update an operating manual file."""
    if filename not in ["SOUL.md", "USER.md", "AGENTS.md"]:
        raise HTTPException(status_code=400, detail="Invalid manual filename")
        
    try:
        file_path = get_workspace_path(workspace) / filename
        file_path.write_text(content.get("content", ""), encoding="utf-8")
        
        # Log the security event
        emit_security_event(
            event_type="MANUAL_UPDATED",
            agent_id="admin_user",
            action=f"Update {filename}",
            result="success",
            details={"filename": filename},
            workspace_id=workspace
        )
        
        return {"status": "updated", "file": filename}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@router.get("/security-events")
async def list_security_events(workspace: str = Query("global"), limit: int = 50):
    """List recent security events from the audit log."""
    # This is a simplified implementation that parses the audit log
    # In a production system, this would query a proper database or indexed log store.
    try:
        result = verify_audit_integrity(workspace)
        # For now, we'll just return a success message or specific tampered events
        # as a placeholder for a more complex log query API.
        return {
            "integrity_status": result,
            "hint": "Security events are mirrored in the governance.log and workspace-specific audit.log"
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@router.get("/verify-audit/{execution_id}")
async def verify_execution_audit(execution_id: str, workspace: str = Query("default")):
    """
    Enhanced audit verification endpoint with detailed failure information.
    Returns comprehensive audit trail including failures, node states, and execution phases.
    """
    try:
        audit = retrieve_execution_audit(execution_id, workspace, include_nodes=True, include_checkpoints=True)
        return audit
    except Exception as e:
        logger.error(f"Error retrieving execution audit for {execution_id}: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@router.get("/execution/{execution_id}/failures")
async def get_execution_failures(execution_id: str, workspace: str = Query("default")):
    """
    Get all failures recorded for a specific execution.
    Useful for quickly identifying what went wrong.
    """
    try:
        audit = retrieve_execution_audit(execution_id, workspace, include_nodes=False)
        return {
            "execution_id": execution_id,
            "status": audit.get("status"),
            "failure_count": audit["summary"].get("failure_count", 0),
            "failures": audit.get("failures", []),
            "first_error": audit.get("first_error"),
        }
    except Exception as e:
        logger.error(f"Error retrieving failures for {execution_id}: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@router.get("/execution/{execution_id}/nodes")
async def get_execution_nodes(execution_id: str, workspace: str = Query("default")):
    """
    Get detailed node execution states for a specific execution.
    Shows input/output data and execution time for each node.
    """
    try:
        audit = retrieve_execution_audit(execution_id, workspace, include_nodes=True, include_checkpoints=False)
        
        # Extract and organize node data
        nodes_by_status = {"completed": [], "failed": [], "other": []}
        for node_event in audit.get("node_states", []):
            node_data = node_event.get("data", {})
            status = node_data.get("status")
            if status == "completed":
                nodes_by_status["completed"].append(node_data)
            elif status == "failed":
                nodes_by_status["failed"].append(node_data)
            else:
                nodes_by_status["other"].append(node_data)
        
        return {
            "execution_id": execution_id,
            "status": audit.get("status"),
            "summary": audit["summary"],
            "nodes_by_status": nodes_by_status,
        }
    except Exception as e:
        logger.error(f"Error retrieving nodes for {execution_id}: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@router.get("/execution/{execution_id}/report")
async def get_execution_report(execution_id: str, workspace: str = Query("default")):
    """
    Generate a human-readable text report of the execution failure.
    Includes full stack traces and error context.
    """
    try:
        report = generate_execution_report(execution_id, workspace)
        return {
            "execution_id": execution_id,
            "report": report
        }
    except Exception as e:
        logger.error(f"Error generating report for {execution_id}: {e}")
        raise HTTPException(status_code=500, detail=str(e))

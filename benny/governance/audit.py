"""
Benny Governance - Unified Audit Logging
Consolidates lineage, task status, and reasoning logs into a single, verifiable trail.
"""

import os
import json
import logging
import hashlib
import asyncio
import threading
import queue
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, Any, Optional
from logging.handlers import RotatingFileHandler
from enum import Enum

# Configuration
WORKSPACE_ROOT = Path("workspace")
GLOBAL_AUDIT_LOG = WORKSPACE_ROOT / "governance.log"
AUDIT_PAYLOAD_LIMIT = 10 * 1024  # 10KB
ROTATION_MAX_BYTES = 5 * 1024 * 1024  # 5MB
ROTATION_BACKUP_COUNT = 5

class BennyAuditEncoder(json.JSONEncoder):
    """Custom JSON encoder to handle Enums, datetimes, and other complex objects."""
    def default(self, obj):
        if isinstance(obj, Enum):
            return obj.value
        if hasattr(obj, "isoformat"):
            return obj.isoformat()
        if hasattr(obj, "__dict__"):
            return obj.__dict__
        return super().default(obj)

# Global queue and background thread for async logging
_log_queue = queue.Queue()
_worker_thread: Optional[threading.Thread] = None
_stop_event = threading.Event()

def _get_workspace_path(workspace_id: str, subdir: str = "") -> Path:
    """Helper to get workspace-scoped paths without circular imports."""
    path = WORKSPACE_ROOT / workspace_id
    if subdir:
        path = path / subdir
    return path

def _calculate_sha256(data: str) -> str:
    """Calculate SHA-256 hash of a string."""
    return hashlib.sha256(data.encode('utf-8')).hexdigest()

def _audit_worker():
    """Background worker to process audit events from the queue."""
    # Ensure WORKSPACE_ROOT exists
    if not WORKSPACE_ROOT.exists():
        WORKSPACE_ROOT.mkdir(parents=True, exist_ok=True)

    # Global logger with rotation
    global_handler = RotatingFileHandler(
        GLOBAL_AUDIT_LOG,
        maxBytes=ROTATION_MAX_BYTES,
        backupCount=ROTATION_BACKUP_COUNT,
        encoding='utf-8'
    )
    
    while not _stop_event.is_set() or not _log_queue.empty():
        try:
            event = _log_queue.get(timeout=0.1)
        except queue.Empty:
            continue

        try:
            workspace_id = event.get("workspace_id", "global")
            mirror = event.get("mirror", True)
            payload = event.get("payload", {})
            
            # 1. Handle Pass-by-Reference for large payloads
            processed_payload = _process_payload(workspace_id, payload)
            
            # 2. Serialize event for logging
            log_entry = {
                "timestamp": datetime.now(timezone.utc).isoformat(),
                "event_type": event.get("event_type", "GENERIC"),
                "workspace": workspace_id,
                "data": processed_payload
            }
            
            # Add SHA-256 integrity hash before writing
            event_json = json.dumps(log_entry, sort_keys=True, cls=BennyAuditEncoder)
            log_entry["_integrity_hash"] = hashlib.sha256(event_json.encode('utf-8')).hexdigest()
            
            log_line = json.dumps(log_entry, cls=BennyAuditEncoder) + "\n"

            # 3. Write to Global Log
            global_handler.emit(logging.LogRecord(
                name="audit", level=logging.INFO, pathname="", lineno=0,
                msg=log_line.strip(), args=None, exc_info=None
            ))

            # 4. Mirror to Workspace Log if required
            if mirror and workspace_id != "global":
                local_audit_dir = _get_workspace_path(workspace_id, "runs")
                local_audit_dir.mkdir(parents=True, exist_ok=True)
                local_audit_log = local_audit_dir / "audit.log"
                
                with open(local_audit_log, "a", encoding="utf-8") as f:
                    f.write(log_line)
                    f.flush() # Ensure real-time visibility when tailing file
                    
        except Exception as e:
            # We fail silently to avoid crashing the main app, but we print to stderr for debugging
            import sys
            print(f"[ERROR] Audit logger failed: {e}", file=sys.stderr)
        finally:
            _log_queue.task_done()

def _process_payload(workspace_id: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    """
    Check if payload size exceeds limit. If so, offload to a separate file 
    and return a reference with a SHA-256 hash.
    """
    payload_str = json.dumps(payload, cls=BennyAuditEncoder)
    if len(payload_str.encode('utf-8')) < AUDIT_PAYLOAD_LIMIT:
        return payload

    # Calculate hash for verification
    content_hash = _calculate_sha256(payload_str)
    
    # Store artifact
    artifact_id = f"audit_ref_{content_hash[:16]}"
    artifact_dir = _get_workspace_path(workspace_id, "runs/artifacts")
    artifact_dir.mkdir(parents=True, exist_ok=True)
    
    artifact_path = artifact_dir / f"{artifact_id}.json"
    artifact_path.write_text(payload_str, encoding='utf-8')
    
    return {
        "_type": "reference",
        "ref": str(artifact_path.relative_to(WORKSPACE_ROOT)),
        "sha256": content_hash,
        "size": len(payload_str),
        "hint": "Payload exceeded threshold and was offloaded for performance."
    }

def start_audit_service():
    """Start the background audit worker thread."""
    global _worker_thread
    if _worker_thread is None or not _worker_thread.is_alive():
        _stop_event.clear()
        _worker_thread = threading.Thread(target=_audit_worker, name="BennyAuditWorker", daemon=True)
        _worker_thread.start()

def stop_audit_service():
    """Stop the background audit worker thread."""
    _stop_event.set()
    if _worker_thread:
        _worker_thread.join(timeout=2.0)

def emit_governance_event(event_type: str, data: Dict[str, Any], workspace_id: str = "global", mirror: bool = True):
    """
    Public API to emit a governance event.
    Enqueues the event for async processing.
    """
    # Ensure service is running
    start_audit_service()
    
    _log_queue.put({
        "event_type": event_type,
        "payload": data,
        "workspace_id": workspace_id,
        "mirror": mirror
    })

def emit_security_event(
    event_type: str,
    agent_id: str,
    action: str,
    result: str,
    details: Dict[str, Any] = None,
    workspace_id: str = "global"
):
    """
    Emit a security-specific audit event.
    
    Event types:
      - UNAUTHORIZED_ACCESS: Agent tried to access something it shouldn't
      - PERMISSION_VIOLATION: RBAC check failed
      - MANIFEST_VIOLATION: Tool exceeded its declared capabilities
      - CREDENTIAL_ACCESS: Credential was accessed from the vault
      - RATE_LIMIT_EXCEEDED: Agent exceeded call rate limits
    """
    emit_governance_event(
        event_type=f"SECURITY_{event_type}",
        data={
            "agent_id": agent_id,
            "action": action,
            "result": result,
            "details": details or {},
            "co_authored_by": "ai_agent",  # Explicit AI disclosure per PRD
        },
        workspace_id=workspace_id
    )

def verify_audit_integrity(workspace_id: str = "global") -> Dict[str, Any]:
    """
    Verify the integrity of the audit log by checking SHA-256 hashes.
    
    Returns:
        {
            "total_events": int,
            "verified": int,
            "tampered": int,
            "missing_hash": int,
            "tampered_events": [...]
        }
    """
    if workspace_id == "global":
        audit_path = GLOBAL_AUDIT_LOG
    else:
        audit_path = _get_workspace_path(workspace_id, "runs/audit.log")
        
    if not audit_path.exists():
        return {"total_events": 0, "verified": 0, "tampered": 0, "missing_hash": 0}
    
    total = 0
    verified = 0
    tampered = 0
    missing_hash = 0
    tampered_events = []
    
    try:
        content = audit_path.read_text(encoding="utf-8")
        for line_num, line in enumerate(content.splitlines(), 1):
            line = line.strip()
            if not line:
                continue
            
            total += 1
            try:
                event = json.loads(line)
                stored_hash = event.pop("_integrity_hash", None)
                
                if stored_hash is None:
                    # Note: Legacy events might not have a hash
                    missing_hash += 1
                    continue
                
                # Recompute hash without the _integrity_hash field
                # Use sort_keys=True for deterministic serialization
                recomputed = hashlib.sha256(
                    json.dumps(event, sort_keys=True, cls=BennyAuditEncoder).encode('utf-8')
                ).hexdigest()
                
                if recomputed == stored_hash:
                    verified += 1
                else:
                    tampered += 1
                    tampered_events.append({
                        "line": line_num,
                        "event_type": event.get("event_type", "UNKNOWN"),
                        "expected_hash": stored_hash,
                        "actual_hash": recomputed,
                    })
            except (json.JSONDecodeError, KeyError):
                missing_hash += 1
    except Exception as e:
        logger.error(f"Error during audit integrity check: {e}")
        return {"error": str(e), "total_events": total}
    
    return {
        "total_events": total,
        "verified": verified,
        "tampered": tampered,
        "missing_hash": missing_hash,
        "tampered_events": tampered_events,
    }

# Auto-start service on import if main
if __name__ == "__main__":
    # Test block
    emit_governance_event("TEST_START", {"msg": "Initializing test run"}, "default")
    emit_governance_event("TEST_LARGE", {"msg": "A" * 15000}, "default")
    import time
    time.sleep(1)
    stop_audit_service()
    print("Test complete. Check workspace/governance.log and workspace/default/runs/audit.log")

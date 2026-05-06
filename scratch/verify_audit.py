import sys
import os
import json
import time
import hashlib
from pathlib import Path

# Add benny to path
sys.path.append(str(Path(__file__).parent.parent))

from benny.governance.audit import emit_governance_event, stop_audit_service

def test_audit_system():
    print("--- Starting Audit System Verification ---")
    
    # 1. Emit small event
    print("Emitting small event...")
    emit_governance_event("VERIFY_SMALL", {"msg": "Hello audit"}, "test_verify")
    
    # 2. Emit large event (>10KB)
    print("Emitting large event (>10KB)...")
    large_data = "X" * 12000 # ~12KB
    emit_governance_event("VERIFY_LARGE", {"content": large_data}, "test_verify")
    
    # Wait for async processing
    print("Waiting for async logging to complete...")
    time.sleep(2)
    stop_audit_service()
    
    # 3. Check logs
    gov_log = Path("workspace/governance.log")
    work_log = Path("workspace/test_verify/runs/audit.log")
    
    print(f"Checking {gov_log}...")
    if gov_log.exists():
        lines = gov_log.read_text(encoding='utf-8').splitlines()
        print(f"Global log has {len(lines)} lines.")
        last_line = json.loads(lines[-1])
        if last_line["event_type"] == "VERIFY_LARGE":
            data = last_line["data"]
            if data["_type"] == "reference":
                print("SUCCESS: Large payload offloaded to reference.")
                ref_path = Path("workspace") / data["ref"]
                sha256 = data["sha256"]
                
                if ref_path.exists():
                    print(f"Artifact exists at {ref_path}")
                    # Verify hash
                    content = ref_path.read_text(encoding='utf-8')
                    actual_hash = hashlib.sha256(content.encode('utf-8')).hexdigest()
                    if actual_hash == sha256:
                        print(f"SUCCESS: SHA-256 match ({sha256[:16]}...)")
                    else:
                        print(f"FAILURE: SHA-256 mismatch! Expected {sha256}, got {actual_hash}")
                else:
                    print(f"FAILURE: Artifact not found at {ref_path}")
            else:
                print("FAILURE: Large payload was NOT offloaded.")
    else:
        print(f"FAILURE: {gov_log} not found.")

    print(f"Checking {work_log}...")
    if work_log.exists():
        lines = work_log.read_text(encoding='utf-8').splitlines()
        print(f"Workspace log has {len(lines)} lines.")
    else:
        print(f"FAILURE: {work_log} not found.")

if __name__ == "__main__":
    test_audit_system()

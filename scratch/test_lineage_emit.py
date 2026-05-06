import sys
import os
import uuid
import time

# Add the project root to sys.path
sys.path.append(os.getcwd())

try:
    from benny.governance.lineage import (
        track_workflow_start, 
        track_workflow_complete,
        track_llm_call
    )
    print("[SUCCESS] Successfully imported lineage module")
except ImportError as e:
    print(f"[ERROR] Failed to import lineage module: {e}")
    sys.exit(1)

def run_test():
    workflow_id = str(uuid.uuid4())
    workflow_name = "test_diagnostics"
    workspace = "diagnostics_lab"
    
    print(f"[*] Starting test workflow: {workflow_name} ({workflow_id})")
    try:
        track_workflow_start(workflow_id, workflow_name, workspace)
        print("[SUCCESS] Workflow START event emitted")
        
        # Simulate an LLM call
        time.sleep(1)
        print("[*] Emitting LLM call event...")
        track_llm_call(
            parent_run_id=workflow_id,
            model="gpt-4o",
            provider="openai",
            usage={"total_tokens": 150}
        )
        print("[SUCCESS] LLM call event emitted")
        
        # Complete workflow
        time.sleep(1)
        print("[*] Completing workflow...")
        track_workflow_complete(
            workflow_id=workflow_id,
            workflow_name=workflow_name,
            nodes_executed=["start", "llm_call", "end"],
            execution_time_ms=2500
        )
        print("[SUCCESS] Workflow COMPLETE event emitted")
        
        print("\n[FINISH] Test sequence finished! Please check http://localhost:3010")
        print("Look for the 'benny' namespace and the 'workflow.test_diagnostics' job.")
        
    except Exception as e:
        print(f"[ERROR] Error during event emission: {e}")

if __name__ == "__main__":
    run_test()

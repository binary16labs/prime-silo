import asyncio
import sys
import os
import uuid
import logging

# Add project root to path
ROOT = os.getcwd()
if ROOT not in sys.path:
    sys.path.append(ROOT)

# Use absolute imports from the 'benny' package
from benny.api.studio_executor import StudioNode, execute_llm_node
from benny.governance.permission_manifest import register_builtin_manifests, register_manifest, create_ephemeral_manifest
from benny.governance.audit import stop_audit_service

async def run_diagnostic():
    # 1. Initialize built-in manifests
    register_builtin_manifests()
    
    # 2. Simulate Chat Agent Run ID
    run_id = f"diag-agent-{uuid.uuid4().hex[:8]}"
    print(f"Simulating Agent Run: {run_id}")
    
    # 3. Security: Register ephemeral manifest for this specific run
    # Ensure we use the exact same SkillRegistry instance as the rest of the app
    chat_manifest = create_ephemeral_manifest(run_id, ["query_graph", "search_kb", "read_file"])
    register_manifest(chat_manifest)
    
    # Debug manifest registration
    from benny.governance.permission_manifest import get_manifest
    m = get_manifest(run_id)
    print(f"DEBUG: Manifest registered for {run_id}: {'YES' if m else 'NO'}")
    
    node = StudioNode(
        id="test_node",
        type="llm",
        position={"x": 0, "y": 0},
        data={
            "label": "Test Agent",
            "config": {
                "model": "", # Auto-detect
                "systemPrompt": "You are a graph expert. Use the query_graph tool to find nodes. I permit you to run any query.",
                "skills": ["query_graph", "search_kb", "read_file"]
            }
        }
    )
    
    context = {"message": "Query the graph to find all nodes and relationships related to 'event_bus'."}
    workspace = "default"
    
    print(f"Running LLM node diagnostic with ephemeral auth...")
    try:
        # Pass run_id as both run_id (lineage) and agent_id (security)
        result = await execute_llm_node(node, context, workspace, run_id=run_id, agent_id=run_id)
        if result.get("error"):
             print(f"\nERROR RETURNED: {result['error']}")
        else:
             print(f"\nSUCCESS! Assistant Response: {result.get('response')[:200]}...")
    except Exception as e:
        print(f"CRASH: {e}")
    finally:
        # Ensure audit logs are flushed before exiting
        import time
        time.sleep(1)
        stop_audit_service()
        print("\nAudit service stopped. Diagnostic complete.")

if __name__ == "__main__":
    asyncio.run(run_diagnostic())

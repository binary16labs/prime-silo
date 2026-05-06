import asyncio
import json
import os
import sys

# Ensure project root is in path
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

async def test_skills():
    from benny.core.skill_registry import registry
    from benny.gateway.rbac import AgentRole
    from benny.api.rag_routes import create_ephemeral_manifest, register_manifest
    
    workspace = "c3_test"
    run_id = "test-run-123"
    
    # REGISTER PERMISSION MANIFEST FOR TEST
    manifest = create_ephemeral_manifest(run_id, ["rag_ingest", "kg3d_ingest", "query_graph", "search_kb"])
    register_manifest(manifest)
    
    print("--- Testing Skill Registration ---")
    skills = registry.get_all_skills(workspace)
    ids = [s.id for s in skills]
    
    if "rag_ingest" in ids:
        print("[OK] Skill 'rag_ingest' is registered.")
    else:
        print("[FAIL] Skill 'rag_ingest' NOT found.")
        
    if "kg3d_ingest" in ids:
        print("[OK] Skill 'kg3d_ingest' is registered.")
    else:
        print("[FAIL] Skill 'kg3d_ingest' NOT found.")

    print("\n--- Testing execution of rag_ingest (Dry Run) ---")
    try:
        # Note: registry.execute_skill is now async
        # We use a dummy file
        result = await registry.execute_skill(
            skill_id="rag_ingest",
            workspace=workspace,
            agent_role="executor",
            agent_id=run_id,
            files=["README.md"]
        )
        # Use ASCII for Windows console safety
        print(f"Result: {result.encode('ascii', 'ignore').decode()}")
        print("[OK] rag_ingest trigger successful.")
    except Exception as e:
        print(f"Result: [ERROR] {str(e).encode('ascii', 'ignore').decode()}")
        print("[ERROR] rag_ingest trigger failed.")

    print("\n--- Testing execution of kg3d_ingest (Dry Run) ---")
    try:
        # Note: registry.execute_skill is now async
        result = await registry.execute_skill(
            skill_id="kg3d_ingest",
            workspace=workspace,
            agent_role="executor",
            agent_id=run_id,
            correlation_threshold=0.8
        )
        print(f"Result: {result.encode('ascii', 'ignore').decode()}")
        print("[OK] kg3d_ingest trigger successful.")
    except Exception as e:
        print(f"Result: [ERROR] {str(e).encode('ascii', 'ignore').decode()}")
        print("[ERROR] kg3d_ingest trigger failed.")

if __name__ == "__main__":
    # Ensure UTF-8 output if possible, otherwise fallback to ASCII
    if sys.platform == 'win32':
        import io
        sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
    
    asyncio.run(test_skills())

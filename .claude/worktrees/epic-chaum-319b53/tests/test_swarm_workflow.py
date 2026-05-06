"""
Test script for Swarm Planner Workflow
Verifies the end-to-end execution of the swarm workflow
"""

import asyncio
import httpx
import json
import time
from pathlib import Path


API_BASE = "http://localhost:8005"


async def test_swarm_workflow():
    """Test the swarm workflow end-to-end"""
    
    print("=" * 60)
    print("SWARM WORKFLOW TEST")
    print("=" * 60)
    
    # Test request
    request = {
        "workflow": "swarm",
        "workspace": "default",
        "message": "Create a 3-section guide on Python async programming covering: 1) Basic concepts of asyncio, 2) Creating async functions, 3) Error handling in async code",
        "model": "ollama/llama3.2",  # Change to your local model
        "params": {
            "max_concurrency": 1  # Safe for local LLM
        }
    }
    
    async with httpx.AsyncClient(timeout=300.0) as client:
        # 1. Execute workflow
        print("\n[1] Submitting swarm workflow...")
        response = await client.post(
            f"{API_BASE}/workflow/execute",
            json=request
        )
        
        if response.status_code != 200:
            print(f"❌ Failed to submit workflow: {response.text}")
            return False
        
        result = response.json()
        execution_id = result["execution_id"]
        governance_url = result.get("governance_url")
        
        print(f"✅ Workflow submitted: {execution_id}")
        print(f"   Governance URL: {governance_url}")
        
        # 2. Poll for completion
        print("\n[2] Waiting for completion...")
        max_wait = 300  # 5 minutes
        start = time.time()
        
        while time.time() - start < max_wait:
            status_response = await client.get(
                f"{API_BASE}/workflow/{execution_id}/status"
            )
            
            if status_response.status_code != 200:
                print(f"❌ Failed to get status: {status_response.text}")
                return False
            
            status = status_response.json()
            current_status = status.get("status")
            
            print(f"   Status: {current_status}")
            
            if current_status in ["completed", "partial_success"]:
                print(f"\n✅ Workflow {current_status}!")
                break
            elif current_status == "failed":
                print(f"\n❌ Workflow failed: {status.get('error')}")
                return False
            
            await asyncio.sleep(5)
        else:
            print("\n❌ Timeout waiting for workflow")
            return False
        
        # 3. Check results
        print("\n[3] Checking results...")
        
        artifact_path = status.get("artifact_path")
        if artifact_path:
            print(f"   Artifact: {artifact_path}")
            
            # Check if file exists
            if Path(artifact_path).exists():
                content = Path(artifact_path).read_text()
                print(f"   Content length: {len(content)} chars")
                print(f"\n   Preview (first 500 chars):")
                print("-" * 40)
                print(content[:500])
                print("-" * 40)
            else:
                print(f"   ⚠️ Artifact file not found!")
        else:
            print("   ⚠️ No artifact path in response")
        
        # 4. Check plan
        plan = status.get("plan")
        if plan:
            print(f"\n   Plan had {len(plan)} tasks:")
            for task in plan:
                print(f"   - Task {task.get('task_id')}: {task.get('description')[:50]}...")
        
        # 5. Check governance URL
        if governance_url:
            print(f"\n[4] Governance URL: {governance_url}")
            print("   (Open in browser to view lineage in Marquez)")
        
        print("\n" + "=" * 60)
        print("TEST COMPLETE")
        print("=" * 60)
        
        return True


if __name__ == "__main__":
    print("Make sure the API server is running: uvicorn benny.api.server:app --reload")
    print("Make sure your LLM is available (Ollama, FastFlowLM, etc.)")
    print()
    
    success = asyncio.run(test_swarm_workflow())
    exit(0 if success else 1)

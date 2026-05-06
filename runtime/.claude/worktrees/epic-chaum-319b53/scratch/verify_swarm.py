import asyncio
import os
import sys
from pathlib import Path

# Add project root to sys.path
sys.path.append(str(Path(__file__).parent.parent))

from benny.graph.swarm import run_swarm_workflow
from benny.core.workspace import ensure_workspace_structure

async def test_declarative_swarm():
    print("🚀 Starting Swarm Verification Test...")
    workspace = "test_swarm_workspace"
    ensure_workspace_structure(workspace)
    
    # Mock files
    data_in = Path("workspace") / workspace / "data_in"
    (data_in / "test_input.txt").write_text("Test Content", encoding="utf-8")
    
    execution_id = "test-exec-001"
    request = "Analyze the test input and provide a summary."
    
    input_files = ["test_input.txt"]
    output_files = ["Strategic_Summary_Test.md"]
    config = {"synthesis_mode": "additive"}
    
    print(f"👉 Executing swarm with output: {output_files[0]}")
    
    result = await run_swarm_workflow(
        request=request,
        workspace=workspace,
        model="ollama/llama3.2",
        execution_id=execution_id,
        input_files=input_files,
        output_files=output_files,
        config=config
    )
    
    print(f"✅ Status: {result['status']}")
    print(f"✅ Artifact Path: {result['artifact_path']}")
    
    # Check if the output filename matches what we declared
    expected_filename = output_files[0]
    actual_filename = os.path.basename(result['artifact_path'])
    
    if expected_filename == actual_filename:
        print(f"🎉 SUCCESS: Output filename matches declaration!")
    else:
        print(f"❌ FAILURE: Output filename {actual_filename} != {expected_filename}")

if __name__ == "__main__":
    asyncio.run(test_declarative_swarm())

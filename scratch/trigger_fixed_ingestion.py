import asyncio
import json
from pathlib import Path
import sys

# Add project root to path
sys.path.append(str(Path(__file__).parent))

from benny.graph.manifest_runner import execute_manifest
from benny.core.manifest import SwarmManifest

async def run_ingestion():
    manifest_path = Path(r"c:\Users\nsdha\OneDrive\code\benny\workspace\c3_test\manifests\ingest_and_index.json")
    
    with open(manifest_path, "r") as f:
        manifest_data = json.load(f)
    
    # workspace "c4_test" is already in the manifest, but let's ensure it's validated correctly
    manifest = SwarmManifest.model_validate(manifest_data)
    manifest.workspace = "c4_test" # Override just in case
    
    print(f"Triggering manifest: {manifest.name} (id={manifest.id}) for workspace: {manifest.workspace}")
    
    record = await execute_manifest(manifest)
    
    print("\nINGESTION_RESULT_START")
    print(record.model_dump_json(indent=2))
    print("INGESTION_RESULT_END")

if __name__ == "__main__":
    asyncio.run(run_ingestion())

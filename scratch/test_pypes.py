import asyncio
import os
import sys

# Force UTF-8 for Windows console
if sys.platform == "win32":
    sys.stdout.reconfigure(encoding='utf-8')
    sys.stderr.reconfigure(encoding='utf-8')

from benny.pypes.planner import plan_pypes_manifest

def main():
    print("Testing pypes planner directly with 4B model...")
    try:
        manifest, meta = plan_pypes_manifest(
            requirement="Create a full pipeline manifest that first extracts FrolovRoutledge2024.pdf from staging, ingests it into ChromaDB, and performs a deep synthesis into the Neo4j graph. Once ingested, use a swarm comparison step to have all available models generate a book report concurrently, followed by a final synthesized review from the Judge model.",
            workspace="test1",
            model="lemonade/qwen3-tk-4b-FLM"
        )
        print("SUCCESS! Generated manifest:")
        print(manifest.model_dump_json(indent=2))
    except Exception as e:
        import traceback
        traceback.print_exc()

if __name__ == "__main__":
    main()

import asyncio
import os
import sys

# Force UTF-8 for Windows console
if sys.platform == "win32":
    sys.stdout.reconfigure(encoding='utf-8')
    sys.stderr.reconfigure(encoding='utf-8')

from benny.graph.manifest_runner import plan_from_requirement
from benny.core.models import get_model_config

async def main():
    print("Testing planner directly...")
    try:
        manifest = await plan_from_requirement(
            requirement="Create a full pipeline manifest that first extracts FrolovRoutledge2024.pdf from staging, ingests it into ChromaDB, and performs a deep synthesis into the Neo4j graph. Once ingested, use a swarm comparison step to have all available models generate a book report concurrently, followed by a final synthesized review from the Judge model.",
            workspace="test1",
            model="local_lemonade"
        )
        print("SUCCESS! Generated tasks:")
        for t in manifest.plan.tasks:
            print(f" - {t.task_id}: {t.description}")
    except Exception as e:
        import traceback
        traceback.print_exc()

if __name__ == "__main__":
    asyncio.run(main())

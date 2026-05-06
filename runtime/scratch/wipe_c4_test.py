import os
import shutil
from pathlib import Path
from benny.core.graph_db import write_session, get_driver

def wipe_workspace(workspace_id: str):
    print(f"Wiping data for workspace: {workspace_id}")
    
    # 1. Wipe Neo4j
    print("Clearing Neo4j nodes...")
    try:
        with write_session() as session:
            result = session.run(
                "MATCH (n {workspace: $ws}) DETACH DELETE n",
                ws=workspace_id
            )
            summary = result.consume()
            print(f"Deleted {summary.counters.nodes_deleted} nodes and {summary.counters.relationships_deleted} relationships.")
    except Exception as e:
        print(f"Error wiping Neo4j: {e}")

    # 2. Wipe ChromaDB
    chroma_dir = Path("workspace") / workspace_id / "chromadb"
    if chroma_dir.exists():
        print(f"Clearing ChromaDB directory: {chroma_dir}")
        try:
            shutil.rmtree(chroma_dir)
            chroma_dir.mkdir(parents=True, exist_ok=True)
            print("ChromaDB directory cleared.")
        except Exception as e:
            print(f"Error clearing ChromaDB: {e}")
    else:
        print("ChromaDB directory not found.")

if __name__ == "__main__":
    wipe_workspace("c4_test")

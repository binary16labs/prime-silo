import asyncio
import logging
import sys
import os

# Add the project root to sys.path
sys.path.append(os.path.abspath("."))

from benny.core.graph_db import get_driver, write_session

# Configure logging
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger("nexus_repair")

async def repair():
    workspace = "c5_test"
    logger.info(f"Starting Permissive Nexus Repair for: {workspace}")
    
    # 1. Permissive Safe Correlation (Direct Name Matches)
    # We ignore the s.type filter to catch Folders, Documentation, etc.
    query = """
    MATCH (c:Concept {workspace: $workspace})
    MATCH (s:CodeEntity {workspace: $workspace})
    WHERE toLower(c.name) = toLower(s.name)
    MERGE (c)-[r:CORRELATES_WITH]->(s)
    ON CREATE SET
        r.strategy    = 'permissive_safe',
        r.confidence  = 1.0,
        r.rationale   = 'Permissive name match (repairs truncated nexus)',
        r.created_at  = timestamp(),
        r.workspace   = $workspace
    RETURN count(r) as links
    """
    
    with write_session() as session:
        result = session.run(query, workspace=workspace)
        links = result.single()["links"]
        logger.info(f"Permissive Safe Correlation: Created {links} links.")

    # 2. Re-run LPA just in case new links change communities
    from benny.graph.clustering_service import ClusteringService
    logger.info("Updating communities based on new links...")
    await ClusteringService.run_lpa_on_workspace(workspace)
    logger.info("Clustering update complete.")

    logger.info("Repair finished. The 3D graph should now show colored clusters linked to your code.")

if __name__ == "__main__":
    asyncio.run(repair())

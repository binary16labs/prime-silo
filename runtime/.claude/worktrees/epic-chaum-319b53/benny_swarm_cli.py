
import asyncio
import sys
import os
import json
import logging
from datetime import datetime

# Set up logging to console
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger("SwarmCLI")

# Add the project root to sys.path
sys.path.append(os.path.abspath(os.path.join(os.getcwd())))

async def test_discovery_swarm(workspace, nexus_id, query):
    logger.info(f"--- STARTING DISCOVERY SWARM CLI TEST ---")
    logger.info(f"Workspace: {workspace}")
    logger.info(f"Nexus ID: {nexus_id}")
    logger.info(f"Query: {query}")
    
    run_id = f"cli-test-{datetime.now().strftime('%H%M%S')}"
    
    try:
        from benny.graph.discovery_swarm import run_discovery_swarm
        
        start_time = datetime.now()
        
        # We wrap the call just like rag_routes.py does
        logger.info(f"Invoking run_discovery_swarm (RunID: {run_id})...")
        swarm_result = await run_discovery_swarm(
            workspace=workspace,
            nexus_id=nexus_id,
            query=query,
            run_id=run_id
        )
        
        duration = (datetime.now() - start_time).total_seconds()
        logger.info(f"Swarm completed in {duration:.2f}s")
        
        # Check result
        findings = swarm_result.get("findings", [])
        status = swarm_result.get("status", "unknown")
        
        logger.info(f"Final Status: {status}")
        logger.info(f"Findings Count: {len(findings)}")
        
        for i, finding in enumerate(findings):
            logger.info(f"Finding {i+1}: {finding}")
            
        # Verify Audit structure (Simulated as if returned by API)
        lineage_audit = {
            "run_id": run_id,
            "workspace": workspace,
            "mode": "discovery_swarm",
            "timestamp": start_time.isoformat()
        }
        
        logger.info(f"--- AUDIT PREVIEW ---")
        logger.info(json.dumps(lineage_audit, indent=2))
        
    except Exception as e:
        logger.error(f"SWARM FAILED: {str(e)}", exc_info=True)

if __name__ == "__main__":
    # Default parameters for local testing
    # User might need to provide a valid nexus_id
    ws = "default"
    nid = "dangpy-12" # Example from user history
    q = "Explain the core architecture"
    
    if len(sys.argv) > 1:
        nid = sys.argv[1]
    
    asyncio.run(test_discovery_swarm(ws, nid, q))

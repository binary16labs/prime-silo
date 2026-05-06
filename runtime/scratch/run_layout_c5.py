import asyncio
import logging
import sys
import os

# Add the project root to sys.path
sys.path.append(os.path.abspath("."))

from benny.graph.gravity_index import GravityIndex

# Configure logging
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger("gravity_layout")

async def layout():
    workspace = "c5_test"
    logger.info(f"Triggering Gravity Layout for: {workspace}")
    
    gi = GravityIndex(workspace)
    result = await gi.run()
    
    logger.info(f"Layout result: {result}")

if __name__ == "__main__":
    asyncio.run(layout())

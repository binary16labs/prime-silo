from benny.core.graph_db import get_driver
import logging

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

def check_workspace(workspace):
    driver = get_driver()
    with driver.session() as session:
        # Check Concepts
        concept_count = session.run("MATCH (c:Concept {workspace: $ws}) RETURN count(c) as cnt", ws=workspace).single()["cnt"]
        # Check Symbols (File, Class, Function, etc.)
        symbol_count = session.run("MATCH (n {workspace: $ws}) WHERE any(lbl IN labels(n) WHERE lbl IN ['File', 'Class', 'Interface', 'Function', 'Variable']) RETURN count(n) as cnt", ws=workspace).single()["cnt"]
        
        # Sample Concepts
        concepts = session.run("MATCH (c:Concept {workspace: $ws}) RETURN c.name as name LIMIT 5", ws=workspace)
        concept_names = [r["name"] for r in concepts]
        
        # Sample Symbols
        symbols = session.run("MATCH (n {workspace: $ws}) WHERE any(lbl IN labels(n) WHERE lbl IN ['File', 'Class', 'Interface', 'Function', 'Variable']) RETURN n.name as name, labels(n) as lbls LIMIT 5", ws=workspace)
        symbol_names = [f"{r['name']} ({r['lbls']})" for r in symbols]
        
        print(f"Workspace: {workspace}")
        print(f"Concept Count: {concept_count}")
        print(f"Symbol Count: {symbol_count}")
        print(f"Sample Concepts: {concept_names}")
        print(f"Sample Symbols: {symbol_names}")

if __name__ == "__main__":
    check_workspace("code2")
    check_workspace("default")

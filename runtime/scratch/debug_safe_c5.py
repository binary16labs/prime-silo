import sys
import os

# Add the project root to sys.path
sys.path.append(os.path.abspath("."))

from benny.core.graph_db import run_cypher

def debug_safe():
    workspace = "c5_test"
    print(f"Debugging Safe Correlation for: {workspace}")
    
    # 1. Sample Concepts
    res = run_cypher("MATCH (n:Concept {workspace: $ws}) RETURN n.name as name LIMIT 10", {"ws": workspace}, workspace)
    print("Sample Concepts:", [r['name'] for r in res])
    
    # 2. Sample CodeEntities
    res = run_cypher("MATCH (n:CodeEntity {workspace: $ws}) RETURN n.name as name, n.type as type LIMIT 10", {"ws": workspace}, workspace)
    print("Sample CodeEntities:", [f"{r['name']} ({r['type']})" for r in res])
    
    # 3. Check for any overlap
    res = run_cypher("""
        MATCH (c:Concept {workspace: $ws})
        MATCH (s:CodeEntity {workspace: $ws})
        WHERE toLower(c.name) CONTAINS toLower(s.name) OR toLower(s.name) CONTAINS toLower(c.name)
        RETURN count(*) as count
    """, {"ws": workspace}, workspace)
    print(f"Relaxed name matches: {res[0]['count']}")

if __name__ == "__main__":
    debug_safe()

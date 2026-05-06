import sys
import os

# Add the project root to sys.path
sys.path.append(os.path.abspath("."))

from benny.core.graph_db import run_cypher

def check():
    workspace = "c5_test"
    print(f"Checking graph for workspace: {workspace}")
    
    # 1. Count Concepts
    res = run_cypher("MATCH (n:Concept {workspace: $ws}) RETURN count(n) as count", {"ws": workspace}, workspace)
    print(f"Concepts: {res[0]['count']}")
    
    # 2. Count CodeEntities
    res = run_cypher("MATCH (n:CodeEntity {workspace: $ws}) RETURN count(n) as count", {"ws": workspace}, workspace)
    print(f"CodeEntities: {res[0]['count']}")
    
    # 3. Count Correlation Links
    res = run_cypher("MATCH (c:Concept {workspace: $ws})-[r:CORRELATES_WITH]->(s) RETURN count(r) as count", {"ws": workspace}, workspace)
    print(f"CORRELATES_WITH links: {res[0]['count']}")
    
    # 4. Check Communities
    res = run_cypher("MATCH (n {workspace: $ws}) WHERE n.community_id IS NOT NULL RETURN count(n) as count", {"ws": workspace}, workspace)
    print(f"Nodes with community_id: {res[0]['count']}")

if __name__ == "__main__":
    check()

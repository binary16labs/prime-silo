from benny.core.graph_db import get_driver
import json

def check_stats():
    driver = get_driver()
    workspace = "c4_test"
    
    with driver.session() as session:
        # Check total nodes and triples
        res = session.run("""
            MATCH (n {workspace: $ws})
            RETURN count(n) as node_count
        """, ws=workspace)
        nodes = res.single()["node_count"]
        
        res = session.run("""
            MATCH ()-[r {workspace: $ws}]->()
            RETURN count(r) as edge_count
        """, ws=workspace)
        edges = res.single()["edge_count"]
        
        # Check source files processed
        res = session.run("""
            MATCH (s:Source {workspace: $ws})
            RETURN s.name as name, s.triples_extracted as triples
        """, ws=workspace)
        sources = [{"name": r["name"], "triples": r["triples"]} for r in res]
        
    print(json.dumps({
        "workspace": workspace,
        "nodes": nodes,
        "edges": edges,
        "sources": sources
    }, indent=2))

if __name__ == "__main__":
    check_stats()

from benny.core.graph_db import run_cypher

query = "MATCH (n {workspace: $ws}) RETURN n.community_id as community, count(*) as count ORDER BY count DESC"
results = run_cypher(query, {"ws": "c5_test"})
print(f"Communities in c5_test: {results[:10]}")

from benny.core.graph_db import read_session
with read_session() as session:
    result = session.run("MATCH (n {workspace: $ws}) RETURN labels(n) as labels, count(n) as count", ws="c5_test")
    for record in result:
        print(f"{record['labels']}: {record['count']}")

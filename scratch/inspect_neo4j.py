from benny.core.graph_db import write_session

def check(tx):
    result = tx.run('MATCH (n {workspace: "c4_test"}) RETURN n LIMIT 1').single()
    if result:
        return result['n']
    return None

node = write_session(check)
if node:
    print(f"Node: {node}")
    print(f"Properties: {dict(node)}")
else:
    print("No node found for c4_test")

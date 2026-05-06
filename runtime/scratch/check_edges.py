from benny.core.graph_db import get_driver

def check():
    driver = get_driver()
    with driver.session() as session:
        # Check specific edges
        res = session.run("MATCH ()-[r:RELATES_TO]->() WHERE r.workspace = 'c4_test' RETURN count(r) as c")
        print(f"RELATES_TO (with workspace property): {res.single()['c']}")

        res2 = session.run("MATCH (n {workspace: 'c4_test'})-[r:RELATES_TO]->(m {workspace: 'c4_test'}) RETURN count(r) as c")
        print(f"RELATES_TO (between workspace nodes): {res2.single()['c']}")
        
        res3 = session.run("MATCH (n {workspace: 'c4_test'})-[r]->(m {workspace: 'c4_test'}) RETURN type(r) as type, count(r) as c")
        print("All edges between workspace nodes:")
        for rec in res3:
            print(f"  {rec['type']}: {rec['c']}")

if __name__ == "__main__":
    check()

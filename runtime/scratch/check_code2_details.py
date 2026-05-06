from benny.core.graph_db import get_driver

def check_code2_details():
    driver = get_driver()
    with driver.session() as session:
        # Check types
        res = session.run("MATCH (n:CodeEntity {workspace: 'code2'}) RETURN n.type as type, count(n) as cnt")
        for r in res:
            print(f"Type: {r['type']}, Count: {r['cnt']}")
            
        # Check concept names again
        res = session.run("MATCH (c:Concept {workspace: 'code2'}) RETURN c.name as name")
        concepts = [r["name"] for r in res]
        print(f"Concepts: {concepts}")
        
        # Check some CodeEntity names
        res = session.run("MATCH (n:CodeEntity {workspace: 'code2'}) RETURN n.name as name LIMIT 10")
        entities = [r["name"] for r in res]
        print(f"Entities: {entities}")

if __name__ == "__main__":
    check_code2_details()

from benny.core.graph_db import get_driver

def inspect_code_entity():
    driver = get_driver()
    with driver.session() as session:
        res = session.run("MATCH (n:CodeEntity) RETURN n LIMIT 1")
        record = res.single()
        if record:
            print(f"CodeEntity Properties: {record['n'].items()}")
            print(f"CodeEntity Labels: {labels(record['n']) if 'labels' in locals() else 'Check labels manual'}")
            # Labels is a function in cypher, I'll just get from the node object if possible
            # But in python driver it's a bit different. Let's do it via Cypher
            labels_res = session.run("MATCH (n:CodeEntity) RETURN labels(n) as lbls LIMIT 1")
            print(f"Labels: {labels_res.single()['lbls']}")

if __name__ == "__main__":
    inspect_code_entity()

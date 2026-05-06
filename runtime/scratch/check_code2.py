from benny.core.graph_db import get_driver

def check_code2_entities():
    driver = get_driver()
    with driver.session() as session:
        count = session.run("MATCH (n:CodeEntity {workspace: 'code2'}) RETURN count(n) as cnt").single()["cnt"]
        print(f"CodeEntity count in 'code2': {count}")
        
        # What properties DO exist on CodeEntity?
        res = session.run("MATCH (n:CodeEntity) RETURN n LIMIT 1")
        record = res.single()
        if record:
            print(f"Properties: {list(record['n'].keys())}")

if __name__ == "__main__":
    check_code2_entities()

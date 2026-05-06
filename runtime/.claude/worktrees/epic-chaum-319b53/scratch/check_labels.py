from benny.core.graph_db import get_driver

def check_labels():
    driver = get_driver()
    with driver.session() as session:
        # Get all unique labels in the database
        res = session.run("CALL db.labels()")
        labels = [r[0] for r in res]
        print(f"Total Labels: {labels}")
        
        # Check node counts per label
        for label in labels:
            count = session.run(f"MATCH (n:`{label}`) RETURN count(n) as cnt").single()["cnt"]
            print(f"Label: {label}, Count: {count}")

if __name__ == "__main__":
    check_labels()

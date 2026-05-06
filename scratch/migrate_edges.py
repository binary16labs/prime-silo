from benny.core.graph_db import get_driver
import logging

def migrate():
    driver = get_driver()
    workspace = "c4_test"
    query = """
    MATCH (n {workspace: $workspace})-[r:REL]->(m {workspace: $workspace})
    MERGE (n)-[r2:RELATES_TO]->(m)
    SET r2 = r, r2.workspace = $workspace
    WITH r DELETE r
    """
    with driver.session() as session:
        res = session.run(query, workspace=workspace)
        print("Migrated REL edges to RELATES_TO")
        
        # Also fix missing workspace on existing RELATES_TO or other edges if needed
        fix_query = """
        MATCH (n {workspace: $workspace})-[r]->(m {workspace: $workspace})
        WHERE r.workspace IS NULL
        SET r.workspace = $workspace
        RETURN count(r) as count
        """
        res2 = session.run(fix_query, workspace=workspace)
        print(f"Fixed workspace property on {res2.single()['count']} edges")

if __name__ == "__main__":
    migrate()

import os
import shutil
from benny.graph.code_analyzer import CodeGraphAnalyzer

def test_constraint_fix():
    # Setup a dummy workspace with duplicate names
    test_ws = os.path.abspath("C:/Users/nsdha/OneDrive/code/benny/scratch/test_ws")
    if os.path.exists(test_ws):
        shutil.rmtree(test_ws)
    os.makedirs(test_ws)
    
    file1 = os.path.join(test_ws, "f1.js")
    with open(file1, "w") as f:
        f.write("class login { }\n")
        
    file2 = os.path.join(test_ws, "f2.js")
    with open(file2, "w") as f:
        f.write("class login { }\n")
        
    print(f"Test workspace created at: {test_ws}")
    
    try:
        analyzer = CodeGraphAnalyzer(test_ws)
        print("Analyzing workspace...")
        analyzer.analyze_workspace()
        
        print("Saving to Neo4j (workspace='test_fix')...")
        # This will test the Cypher query logic against the real DB
        analyzer.save_to_neo4j("test_fix")
        print("SUCCESS: save_to_neo4j completed without ConstraintError.")
        
    except Exception as e:
        print(f"FAILURE: {type(e).__name__}: {e}")
        import traceback
        traceback.print_exc()
    # Cleanup (optional, but keep for now to inspect if needed)
    # shutil.rmtree(test_ws)

if __name__ == "__main__":
    test_constraint_fix()
